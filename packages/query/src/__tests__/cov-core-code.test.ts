/**
 * Coverage: Code builders (concat / indent / json* / joinCode / joinLines),
 * spanFor tie-breaks, and the full problem renderer.
 */
import { describe, it, expect } from 'vitest';
import { Code, code, span, plain, joinCode, joinLines } from '../code';
import { Problems } from '../problem';

describe('Code builders', () => {
  it('concat appends a string (keeping spans) and another Code (shifting spans)', () => {
    const a = span('aa', { path: ['x'] });
    expect(a.concat('!').toString()).toBe('aa!');
    expect(a.concat('!').spanFor(['x'])?.start).toBe(0);
    const combined = a.concat(span('bb', { path: ['y'] }));
    expect(combined.toString()).toBe('aabb');
    expect(combined.spanFor(['y'])?.start).toBe(2);
  });

  it('indent shifts later lines and re-anchors spans; no-ops without prefix/newline', () => {
    const c = code`a\n${span('B', { path: ['p'] })}`;
    const indented = c.indent('  ');
    expect(indented.toString()).toBe('a\n  B');
    expect(indented.spanFor(['p'])?.start).toBe(4);
    expect(c.indent('')).toBe(c); // empty prefix → unchanged
    expect(plain('oneline').indent('  ').toString()).toBe('oneline'); // no newline → unchanged
  });

  it('jsonObject / jsonArray / jsonString', () => {
    expect(Code.jsonObject([], { path: [] }).toString()).toBe('{}');
    const obj = Code.jsonObject(
      [
        { key: 'a', value: '1' },
        { key: 'b', value: new Code('2') },
        { key: 'c', value: undefined },
      ],
      { path: [] },
    );
    expect(obj.toString()).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(Code.jsonArray([], { path: [] }).toString()).toBe('[]');
    expect(Code.jsonArray(['1', new Code('2')], { path: [] }).toString()).toBe('[\n  1,\n  2\n]');
    expect(Code.jsonString('hi"there')).toBe('"hi\\"there"');
  });

  it('joinCode handles empty / string-or-Code parts + separators; joinLines newline-joins', () => {
    expect(joinCode([]).toString()).toBe('');
    expect(joinCode(['a', 'b'], '-').toString()).toBe('a-b');
    expect(joinCode([new Code('a'), 'b'], new Code('|')).toString()).toBe('a|b');
    expect(joinLines(['a', 'b']).toString()).toBe('a\nb');
  });

  it('code template interpolates string + Code values', () => {
    expect(code`x${'y'}z`.toString()).toBe('xyz');
  });

  it('spanFor breaks ties by smaller (more specific) range at equal path length', () => {
    const inner = span('x', { path: ['a'] });
    const outer = span(code`(${inner})`, { path: ['a'] });
    const found = outer.spanFor(['a']);
    expect(found?.end! - found?.start!).toBe(1); // the tighter inner span
  });
});

describe('Code.formatProblems renderer', () => {
  const built = code`line1 ${span('AAA', { path: ['a'] })}\nline2 ${span('BBB', { path: ['b'] })}\n${span('', { path: ['gap'] })}line3`;

  it('renders sections with gutters, headers, color, merges, and dedup', () => {
    const p = new Problems();
    p.enter(['a']);
    p.warn('w', 'warn on a');
    p.error('e', 'error on a'); // same span -> dedup, error wins
    p.leave(1);
    p.enter(['b']);
    p.error('e2', 'error on b');
    p.leave(1);
    const out = built.formatProblems(p, { color: true, contextLines: 2 });
    expect(out).toContain('AAA');
    expect(out).toContain('error on a');
    expect(out).toContain('error on b');
    expect(out).toContain('\x1b['); // ANSI color emitted
  });

  it('single-line header, no line numbers / headers off variants', () => {
    const p = new Problems();
    p.enter(['a']);
    p.error('e', 'just a');
    p.leave(1);
    const withHeader = built.formatProblems(p, { contextLines: 0 });
    expect(withHeader).toMatch(/line \d+/);
    const bare = built.formatProblems(p, { lineNumbers: false, sectionHeaders: false });
    expect(bare).toContain('just a');
    expect(bare).not.toMatch(/─/);
  });

  it('multi-line span produces a "lines N-M" header', () => {
    const multi = code`pre ${span(code`AA\nBB`, { path: ['m'] })} post`;
    const p = new Problems();
    p.enter(['m']);
    p.error('e', 'spans two lines');
    p.leave(1);
    const out = multi.formatProblems(p, { contextLines: 0 });
    expect(out).toMatch(/lines \d+-\d+/);
  });

  it('unmatched (with + without a path) and boundary spans fall back to plain lines', () => {
    const p = new Problems();
    p.enter(['nomatch']);
    p.error('e', 'no span here');
    p.leave(1);
    p.enter(['gap']); // matches a zero-length boundary span -> no line hit -> fallback
    p.error('e2', 'boundary span');
    p.leave(1);
    p.error('e3', 'rootless problem'); // empty path -> no span prefix match, no `@ path`
    const out = built.formatProblems(p);
    expect(out).toContain('no span here');
    expect(out).toContain('boundary span');
    // The empty-path fallback line omits the `@ path` suffix.
    const rootlessLine = out.split('\n').find((l) => l.includes('rootless problem'))!;
    expect(rootlessLine).not.toContain('@');
  });

  it('maxProblems caps with a pluralized suppressed note; empty list renders nothing', () => {
    const p = new Problems();
    for (const path of ['a', 'b']) {
      p.enter([path]);
      p.error('e', `at ${path}`);
      p.leave(1);
    }
    p.error('e', 'extra'); // 3 total
    const out = built.formatProblems(p, { maxProblems: 1 });
    expect(out).toMatch(/2 more problems suppressed/); // plural
    // Exactly one suppressed → singular wording.
    const two = new Problems();
    two.enter(['a']);
    two.error('e', 'first');
    two.leave(1);
    two.error('e', 'second');
    expect(built.formatProblems(two, { maxProblems: 1 })).toMatch(/1 more problem suppressed/);
    expect(built.formatProblems(new Problems())).toBe('');
  });
});
