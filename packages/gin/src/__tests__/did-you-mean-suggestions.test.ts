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
import { createRegistry, Engine, didYouMean, nearest, suggestionBudget, editDistance, deepSuggest, alignSegments } from '../index';
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

// ─── deep (whole-path) prediction ─────────────────────────────────────────────

describe('deepSuggest — full-path prediction over a node graph', () => {
  // A plain graph: each key maps to a child node (navigable) or null (scalar leaf).
  type G = { [k: string]: G | null };
  const names = (n: G): string[] => Object.keys(n);
  const children = (n: G): Array<[string, G]> =>
    Object.entries(n).filter((e): e is [string, G] => e[1] !== null);

  const user: G = {
    id: null, name: null, email: null,
    profile: { name: null, avatar: null, bio: null },
    address: { city: null, zip: null },
  };

  it('drops a spurious middle segment: user.usr.name → user.name', () => {
    expect(deepSuggest(user, names, children, ['usr', 'name'])).toEqual(['name']);
  });

  it('inserts a missing intermediate: name (lives under profile) → profile.name', () => {
    const u: G = { id: null, profile: { name: null, avatar: null }, address: { city: null } };
    expect(deepSuggest(u, names, children, ['name'])).toEqual(['profile', 'name']);
  });

  it('fixes a typo on a middle segment: adress.city → address.city', () => {
    expect(deepSuggest(user, names, children, ['adress', 'city'])).toEqual(['address', 'city']);
  });

  it('degrades to a same-level fix (single segment) for a plain typo: nam → name', () => {
    expect(deepSuggest(user, names, children, ['nam'])).toEqual(['name']);
  });

  it('prefers the shallowest match on a tie', () => {
    // `name` exists directly AND under profile; the direct (shorter) path wins.
    expect(deepSuggest(user, names, children, ['name'])).toEqual(['name']);
  });

  it('returns undefined when nothing lines up (no false path)', () => {
    expect(deepSuggest(user, names, children, ['zzzzz', 'qqqqq'])).toBeUndefined();
  });

  it('is cycle-safe on a recursive graph', () => {
    const node: G = { value: null };
    node['next'] = node; // self-cycle
    // Should terminate and find the leaf, not loop forever (`valu` = one deletion).
    expect(deepSuggest(node, names, children, ['valu'])).toEqual(['value']);
  });

  it('alignSegments scores substitutions by char-distance and indels flat', () => {
    expect(alignSegments(['a', 'b'], ['a', 'b'])).toBe(0);
    expect(alignSegments(['a'], ['a', 'b'])).toBe(2); // one indel
    expect(alignSegments(['name'], ['nam'])).toBe(1); // one char sub-distance
  });
});

// ─── end-to-end deep prediction through engine.validate ───────────────────────

describe('validate → deep full-path prediction', () => {
  const r = createRegistry();
  const engine = new Engine(r);
  const Profile = r.obj({ name: { type: r.text() }, avatar: { type: r.text() } });
  const User = r.obj({ id: { type: r.num() }, profile: { type: Profile } });

  it('predicts the full path when a middle key is mistyped (u.profil.name → u.profile.name)', () => {
    const body: ExprDef = { kind: 'get', path: [{ prop: 'u' }, { prop: 'profil' }, { prop: 'name' }] };
    const probs = engine.validate(body, new Map([['u', User]]));
    expect(msg(probs, 'prop.unknown')).toContain('did you mean `u.profile.name`');
  });

  it('predicts a MISSING intermediate level (u.name → u.profile.name)', () => {
    const body: ExprDef = { kind: 'get', path: [{ prop: 'u' }, { prop: 'name' }] };
    const probs = engine.validate(body, new Map([['u', User]]));
    expect(msg(probs, 'prop.unknown')).toContain('did you mean `u.profile.name`');
  });

  it('still gives a bare same-level key for a simple leaf typo (u.profile.nam → name)', () => {
    const body: ExprDef = { kind: 'get', path: [{ prop: 'u' }, { prop: 'profile' }, { prop: 'nam' }] };
    const probs = engine.validate(body, new Map([['u', User]]));
    expect(msg(probs, 'prop.unknown')).toContain('did you mean `name`');
  });

  it('stays silent when nothing lines up', () => {
    const body: ExprDef = { kind: 'get', path: [{ prop: 'u' }, { prop: 'zzzzz' }, { prop: 'qqqqq' }] };
    expect(msg(engine.validate(body, new Map([['u', User]])), 'prop.unknown')).not.toContain('did you mean');
  });
});
