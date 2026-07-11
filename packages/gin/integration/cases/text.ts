/**
 * text / string cases — length/case/trim, split & join, replace, slice, indexOf,
 * the startsWith/contains/endsWith predicates, templating, reverse, and counting.
 *
 * Follow the EvalCase contract (see `types.ts`) and the `a` builder (`assert.ts`):
 * each case is a NL `request` to generate a gin function `(args) => output`, proven
 * by `a.produces(oracle)` over several `inputs`. The oracles below are authored to
 * match gin's REAL text semantics (verified against `src/natives/text.ts`):
 *   - `text.upper`/`text.lower` are plain `toUpperCase()`/`toLowerCase()` (NOT
 *     locale-sensitive); every input here is ASCII so the JS oracle cannot diverge.
 *   - `text.replace(search, replacement)` replaces ALL occurrences
 *     (`str.split(search).join(replacement)`), unlike JS `String.replace` which
 *     only swaps the first — the slugify case leans on this.
 *   - `text.split` / `list.join` / `list.reverse` mirror JS exactly.
 *   - `text.indexOf` returns `-1` when the search is absent.
 * Inputs always include an empty string, mixed case, whitespace, and a no-match so a
 * hard-coded constant answer fails.
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

// ════════════════════════════════════════════════════════════════════════════
// fns-with-distractors: the warehouse catalog code (case `text-fn-catalog`)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The company-specific catalog-code format the model must NOT guess: a fixed
 * `CAT::` prefix, `::` field separators, and the category lowercased with spaces
 * folded to underscores. Only `fns.catalogCode` encodes it, so calling that fn is
 * genuinely load-bearing — no other fn (and no inlined string) reproduces it.
 */
function formatCatalogCode(category: string, serial: string): string {
  return 'CAT::' + category.toLowerCase().split(' ').join('_') + '::' + serial;
}

/** `{ category, serial }` — the argument shape every catalog fn accepts. */
const CATALOG_ARG = {
  name: 'obj',
  props: { category: { type: { name: 'text' } }, serial: { type: { name: 'text' } } },
} as const;

/** One solver (`catalogCode`) plus three plausible-but-wrong formatters. */
const catalogFns: FnSpec[] = [
  {
    name: 'catalogCode',
    args: CATALOG_ARG,
    returns: { name: 'text' },
    impl: (args) => formatCatalogCode(String(args['category']), String(args['serial'])),
    docs: 'Return the official warehouse catalog code for a category + serial (company-specific format)',
    probe: { category: 'Power Tools', serial: 'A1' },
  },
  {
    name: 'slugify',
    args: { name: 'obj', props: { category: { type: { name: 'text' } } } },
    returns: { name: 'text' },
    impl: (args) => String(args['category']).toLowerCase().split(' ').join('-'),
    docs: 'Turn a category into a hyphenated lowercase slug',
    distractor: true,
    probe: { category: 'Power Tools' },
  },
  {
    name: 'upperJoin',
    args: CATALOG_ARG,
    returns: { name: 'text' },
    impl: (args) => String(args['category']).toUpperCase() + '-' + String(args['serial']).toUpperCase(),
    docs: 'Uppercase the category and serial and join them with a dash',
    distractor: true,
    probe: { category: 'garden', serial: 'x9' },
  },
  {
    name: 'tagify',
    args: { name: 'obj', props: { category: { type: { name: 'text' } } } },
    returns: { name: 'text' },
    impl: (args) => '#' + String(args['category']).replace(/\s+/g, ''),
    docs: 'Turn a category into a hashtag',
    distractor: true,
    probe: { category: 'Power Tools' },
  },
];

export const textCases: EvalCase[] = [
  // ── simple ────────────────────────────────────────────────────────────────
  {
    id: 'text-shout',
    category: 'text',
    request: 'Trim the surrounding whitespace from the given string and return it in UPPERCASE.',
    note: 'Compose trim + upper. Upper-only leaves the whitespace; trim-only keeps the original case. Empty and already-trimmed inputs guard against a hard-coded answer.',
    argsType: { name: 'obj', props: { value: { type: { name: 'text' } } } },
    returnType: { name: 'text' },
    inputs: [
      { value: '  hello world  ' },
      { value: 'MixEd Case' },
      { value: '' },
      { value: 'ALREADY' },
      { value: '\t padded\n' },
    ],
    assert: [
      a.produces((args) => String(args['value'] ?? '').trim().toUpperCase()),
      a.returnsType('text'),
    ],
  },
  {
    id: 'text-count-occurrences',
    category: 'text',
    request:
      'Given a string `text` and a non-empty substring `needle`, return how many (non-overlapping) times `needle` occurs in `text`.',
    note: 'No native count exists — the natural gin build is `text.split(needle).length - 1`. Returning the string length, or 1/0 (a boolean contains), fails on the multi-hit and no-match inputs. `needle` is always non-empty so split semantics are well-defined.',
    argsType: {
      name: 'obj',
      props: { text: { type: { name: 'text' } }, needle: { type: { name: 'text' } } },
    },
    returnType: { name: 'num' },
    inputs: [
      { text: 'banana', needle: 'a' },
      { text: 'mississippi', needle: 'ss' },
      { text: 'hello', needle: 'z' },
      { text: '', needle: 'x' },
      { text: 'aaaa', needle: 'aa' },
    ],
    assert: [
      a.produces((args) => String(args['text'] ?? '').split(String(args['needle'])).length - 1),
      a.returnsType('num'),
    ],
  },

  // ── medium ────────────────────────────────────────────────────────────────
  {
    id: 'text-slugify',
    category: 'text',
    request: 'Convert a title into a URL slug: lowercase it and replace EVERY space with a hyphen.',
    note: "Replace-ALL trap. gin's `text.replace` swaps every occurrence, so `text.replace(' ', '-')` is correct; a model that reasons in JS `String.replace` semantics (first match only) would still be right here, but any 'replace only the first space' construction fails the multi-space inputs. Case-folding must precede/accompany the replace.",
    argsType: { name: 'obj', props: { title: { type: { name: 'text' } } } },
    returnType: { name: 'text' },
    inputs: [
      { title: 'Hello World Foo' },
      { title: 'Already-Slug' },
      { title: '  double  spaces  ' },
      { title: '' },
      { title: 'ONEWORD' },
    ],
    assert: [
      a.produces((args) => String(args['title'] ?? '').toLowerCase().split(' ').join('-')),
      a.returnsType('text'),
    ],
  },
  {
    id: 'text-username-before-at',
    category: 'text',
    request:
      "Return the part of an email-like string that comes before the first '@'. If there is no '@', return the whole string unchanged.",
    note: "slice + indexOf with a conditional. gin's `text.indexOf` returns -1 when absent; `text.slice(0, s.indexOf('@'))` WITHOUT the no-match guard yields `slice(0, -1)` (drops the last char) on the no-'@' input — that is the trap. Empty string also has no '@'.",
    argsType: { name: 'obj', props: { email: { type: { name: 'text' } } } },
    returnType: { name: 'text' },
    inputs: [
      { email: 'alice@example.com' },
      { email: 'bob.smith@corp.io' },
      { email: 'no-at-sign' },
      { email: '' },
      { email: '@leading' },
    ],
    assert: [
      a.produces((args) => {
        const s = String(args['email'] ?? '');
        const i = s.indexOf('@');
        return i === -1 ? s : s.slice(0, i);
      }),
      a.returnsType('text'),
    ],
  },
  {
    id: 'text-reverse-tags',
    category: 'text',
    request:
      "Given a comma-separated string of tags, reverse the ORDER of the tags and re-join them with ', ' (comma-space).",
    note: 'Split on comma → reverse the list<text> → join with a NEW separator. Splitting and joining on the same delimiter (forgetting the space) fails; reversing the characters instead of the list fails; a single-tag input must round-trip unchanged.',
    argsType: { name: 'obj', props: { tags: { type: { name: 'text' } } } },
    returnType: { name: 'text' },
    inputs: [
      { tags: 'a,b,c' },
      { tags: 'solo' },
      { tags: 'red,green,blue,yellow' },
      { tags: '' },
      { tags: 'x, y, z' },
    ],
    assert: [
      a.produces((args) => String(args['tags'] ?? '').split(',').reverse().join(', ')),
      a.returnsType('text'),
    ],
  },

  // ── hard ──────────────────────────────────────────────────────────────────
  {
    id: 'text-docs-url',
    category: 'text',
    request:
      "Return whether a link is a valid docs page: it must START with 'https://', CONTAIN '/docs/', and END with '.html'. All three must hold.",
    note: 'Conjunction of three predicates (startsWith + contains + endsWith), all case-sensitive in gin. Each input flips exactly one condition, so dropping any check (or lowercasing first) produces a wrong boolean on that row.',
    argsType: { name: 'obj', props: { url: { type: { name: 'text' } } } },
    returnType: { name: 'bool' },
    inputs: [
      { url: 'https://site.com/docs/intro.html' },
      { url: 'http://site.com/docs/intro.html' },
      { url: 'https://site.com/blog/intro.html' },
      { url: 'https://site.com/docs/intro.pdf' },
      { url: 'HTTPS://site.com/docs/a.html' },
      { url: '' },
    ],
    assert: [
      a.produces((args) => {
        const s = String(args['url'] ?? '');
        return s.startsWith('https://') && s.includes('/docs/') && s.endsWith('.html');
      }),
      a.returnsType('bool'),
    ],
  },
  {
    id: 'text-person-label',
    category: 'text',
    request:
      "Given a Person with `first` and `last` name fields, return their display label in \"Last, First\" form (the last name, a comma and a space, then the first name).",
    note: "Custom type + templating via string concatenation. Emitting \"First Last\", or joining without the ', ' separator, fails. Empty first/last inputs prove the concat is literal, not a lookup table.",
    setup: (registry) => {
      // Extend a STRUCTURAL `obj({...})` base — `extend('obj', {props})` drops
      // the fields at runtime (parse delegates to the empty base).
      const Person = registry.extend(
        registry.obj({ first: { type: registry.text() }, last: { type: registry.text() } }),
        { name: 'Person', docs: 'A person with a first and last name.' },
      );
      registry.register(Person);
      return [Person];
    },
    argsType: { name: 'obj', props: { person: { type: { name: 'Person' } } } },
    returnType: { name: 'text' },
    inputs: [
      { person: { first: 'Ada', last: 'Lovelace' } },
      { person: { first: 'grace', last: 'hopper' } },
      { person: { first: '', last: 'Cher' } },
      { person: { first: 'Xavier', last: '' } },
    ],
    assert: [
      a.produces((args) => {
        const p = (args['person'] ?? {}) as { first: string; last: string };
        return `${p.last}, ${p.first}`;
      }),
      a.returnsType('text'),
    ],
  },
  {
    id: 'text-fn-catalog',
    category: 'text',
    request:
      'Given a product category and its serial, produce the warehouse catalog code. Use the provided catalog-code function — the exact format is company-specific and must not be assumed.',
    note: "Distractor gauntlet: only `catalogCode` knows the `CAT::…::…` format (prefix, '::' separators, spaces→underscores, lowercase). Inlining a guessed format, or calling slugify / upperJoin / tagify, produces the wrong string. `usesFn(catalogCode)` is a required gate because the format is unknowable otherwise.",
    fns: catalogFns,
    argsType: CATALOG_ARG,
    returnType: { name: 'text' },
    inputs: [
      { category: 'Power Tools', serial: 'A1' },
      { category: 'garden', serial: '99' },
      { category: 'Home & Kitchen', serial: 'zz-7' },
      { category: '', serial: '' },
    ],
    assert: [
      // The format is hidden in the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('catalogCode')),
      a.produces((args) => formatCatalogCode(String(args['category']), String(args['serial']))),
      a.returnsType('text'),
    ],
  },
];
