/**
 * "Did you mean?" suggestions for gin's unknown-NAME diagnostics.
 *
 * `didYouMean` (src/aids.ts) is unit-tested here directly, then wired end-to-end
 * through `engine.validate(...)`: a program that references an unknown variable
 * (`var.unknown`) or an unknown prop (`prop.unknown`) should carry the nearest
 * valid name in the emitted problem message — and NOTHING for a far-off word
 * (no false positives).
 *
 * NOTE: distance is plain Levenshtein (a transposition costs 2), gated by a
 * length-scaled budget (`floor(len/3)`, ≥1, ≤3). So the typos exercised here
 * are single-edit misspellings (`titl` for `title`, `tex` for `text`), which is
 * exactly the "genuine typo" the budget is tuned to catch.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, Engine, didYouMean, nearest, suggestionBudget, editDistance } from '../index';
import type { Problems } from '../problem';
import type { ExprDef } from '../schema';

/** The message of the first problem with `code` (or '' when none). */
function msg(p: Problems, code: string): string {
  return p.list.find((x) => x.code === code)?.message ?? '';
}

// ─── the helper in isolation ──────────────────────────────────────────────────

describe('didYouMean helper', () => {
  it('suggests the nearest name on a genuine (single-edit) typo', () => {
    expect(didYouMean('titl', ['title', 'body', 'author'])).toBe(' — did you mean `title`?');
  });

  it('stays silent (returns "") on an unrelated word', () => {
    expect(didYouMean('zzzzzz', ['title', 'body', 'author'])).toBe('');
  });

  it('matches case-insensitively', () => {
    expect(didYouMean('TITL', ['title', 'body'])).toBe(' — did you mean `title`?');
  });

  it('honors opts.max with an "or" list', () => {
    // `cat` is one edit from both `cot` (a→o) and `car` (t→r).
    expect(didYouMean('cat', ['cot', 'car'], { max: 2 })).toBe(' — did you mean `cot` or `car`?');
  });

  it('honors opts.max with an Oxford-comma list', () => {
    expect(didYouMean('cat', ['cot', 'car', 'bat'], { max: 3 })).toBe(
      ' — did you mean `cot`, `car`, or `bat`?',
    );
  });

  it('exposes its primitives', () => {
    expect(editDistance('titl', 'title')).toBe(1);
    expect(editDistance('titel', 'title')).toBe(2); // a transposition is 2 edits
    expect(suggestionBudget(5)).toBe(1);
    expect(suggestionBudget(9)).toBe(3);
    expect(nearest('titl', ['title', 'body'])).toBe('title');
    expect(nearest('zzzzzz', ['title', 'body'])).toBeUndefined();
  });
});

// ─── end-to-end through engine.validate ───────────────────────────────────────

describe('validate → nearest name in the diagnostic', () => {
  const engine = new Engine(createRegistry());

  it('var.unknown suggests a near bound variable, and stays silent on a far one', () => {
    const near: ExprDef = {
      kind: 'define',
      vars: [{ name: 'title', value: { kind: 'new', type: { name: 'text' }, value: 'hi' } }],
      body: { kind: 'get', path: [{ prop: 'titl' }] },
    };
    expect(msg(engine.validate(near), 'var.unknown')).toContain('did you mean `title`');

    const far: ExprDef = {
      kind: 'define',
      vars: [{ name: 'title', value: { kind: 'new', type: { name: 'text' }, value: 'hi' } }],
      body: { kind: 'get', path: [{ prop: 'zzzzzz' }] },
    };
    expect(msg(engine.validate(far), 'var.unknown')).not.toContain('did you mean');
  });

  it('prop.unknown suggests a near prop name on the receiver type', () => {
    const objType = { name: 'obj', props: { title: { type: { name: 'text' } } } };
    const prog: ExprDef = {
      kind: 'define',
      vars: [{
        name: 'u',
        value: {
          kind: 'new',
          type: objType,
          value: { title: { kind: 'new', type: { name: 'text' }, value: 'hi' } },
        },
      }],
      body: { kind: 'get', path: [{ prop: 'u' }, { prop: 'titl' }] },
    };
    expect(msg(engine.validate(prog), 'prop.unknown')).toContain('did you mean `title`');
  });
});

// ─── registry parse errors ────────────────────────────────────────────────────

describe('registry.parse → nearest type name in the thrown error', () => {
  it('unknown type suggests the nearest built-in class name', () => {
    const r = createRegistry();
    // `tex` is a single-deletion typo of the built-in `text` class. The
    // `options` peer keeps it out of the bare-name (alias) fast path so the
    // unknown-type error actually fires.
    expect(() => r.parse({ name: 'tex', options: {} })).toThrow(/did you mean `text`/);
  });

  it('extends references unknown type suggests the near name', () => {
    const r = createRegistry();
    expect(() => r.parse({ name: 'X', extends: 'tex', props: {} })).toThrow(/did you mean `text`/);
  });
});
