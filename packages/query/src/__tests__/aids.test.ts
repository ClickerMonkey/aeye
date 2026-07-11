/**
 * Unit coverage for the aid-directed error machinery (`src/aids.ts`): the
 * `withAid` seam, the `directedMessage` code→text dispatch, `describeInput`,
 * the edit-distance "did you mean" suggestion, and the `AID_REGISTRY` fallback.
 *
 * `directedMessage` is exercised with hand-built raw issues so every code branch
 * (invalid_type / invalid_value / invalid_union / default) and every
 * `describeInput` arm is hit deterministically, independent of Zod internals.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  withAid,
  aidInfo,
  describeInput,
  editDistance,
  nearestKind,
  nearest,
  didYouMean,
  suggestionBudget,
  directedMessage,
  AID_REGISTRY,
} from '../aids';

// Minimal, exactly-typed raw issues per code (no casts) — `directedMessage`
// reads only `code` / `input` / (enum) `values`, but each Zod issue member has
// its own required fields, so a full literal is supplied for each.
const typeIssue = (input: unknown): z.core.$ZodRawIssue => ({
  code: 'invalid_type',
  expected: 'object',
  input,
  path: [],
});
const valueIssue = (values: z.core.util.Primitive[], input: unknown): z.core.$ZodRawIssue => ({
  code: 'invalid_value',
  values,
  input,
  path: [],
});
const unionIssue = (input: unknown): z.core.$ZodRawIssue => ({
  code: 'invalid_union',
  errors: [],
  input,
  path: [],
});
const otherIssue = (input: unknown): z.core.$ZodRawIssue => ({ code: 'custom', input, path: [] });

describe('aidInfo', () => {
  it('resolves a registered aid to its label + noun', () => {
    expect(aidInfo('Expr')).toEqual({ label: 'an expression', noun: 'expression' });
    expect(AID_REGISTRY['ComparisonOp']!.label).toBe('a comparison operator');
  });

  it('falls back to a generic label for an unregistered aid', () => {
    expect(aidInfo('NotARegisteredAid')).toEqual({ label: 'a `NotARegisteredAid` value' });
  });
});

describe('describeInput', () => {
  it('describes each JSON value kind, and yields no tail for a missing value', () => {
    expect(describeInput(undefined)).toBeUndefined();
    expect(describeInput(null)).toBe('null');
    expect(describeInput([1, 2])).toBe('a list');
    expect(describeInput('x')).toBe('a string');
    expect(describeInput(3)).toBe('a number');
    expect(describeInput(true)).toBe('a boolean');
    expect(describeInput({ a: 1 })).toBe('an object');
    // A non-JSON runtime type (bigint) exercises the `default` (no tail) arm.
    expect(describeInput(10n)).toBeUndefined();
  });
});

describe('editDistance / nearestKind', () => {
  it('computes classic Levenshtein distances', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('comparise', 'comparison')).toBe(2);
  });

  it('suggests the nearest kind for a plausible typo', () => {
    expect(nearestKind('comparise', ['comparison', 'logical', 'binary'])).toBe('comparison');
    expect(nearestKind('slect', ['select', 'insert'])).toBe('select');
  });

  it('suggests nothing when no candidate is within the edit budget', () => {
    expect(nearestKind('not-a-real-kind', ['select', 'insert', 'update'])).toBeUndefined();
  });
});

describe('suggestionBudget', () => {
  it('scales the edit budget with length (>=1, capped at 3)', () => {
    expect(suggestionBudget(0)).toBe(1); // floor(0/3)=0 → clamped up to 1
    expect(suggestionBudget(2)).toBe(1);
    expect(suggestionBudget(3)).toBe(1);
    expect(suggestionBudget(6)).toBe(2);
    expect(suggestionBudget(9)).toBe(3);
    expect(suggestionBudget(30)).toBe(3); // floor(30/3)=10 → capped at 3
  });
});

describe('nearest', () => {
  it('finds the nearest candidate within the default length-scaled budget', () => {
    expect(nearest('nam', ['name', 'age', 'email'])).toBe('name');
    // a far word yields nothing (no false positive)
    expect(nearest('somethingelse', ['name', 'age'])).toBeUndefined();
    // empty candidate set ⇒ nothing
    expect(nearest('name', [])).toBeUndefined();
  });

  it('breaks a case-insensitive-distance tie toward the exact-case spelling', () => {
    // `ab` / `Ab` are both distance 0 case-insensitively from `AB`; the
    // case-SENSITIVE distance (1 vs 2) favors `Ab`.
    expect(nearest('AB', ['ab', 'Ab'])).toBe('Ab');
  });

  it('honors an explicit budget override', () => {
    // distance 1 but budget 0 ⇒ no match
    expect(nearest('abcdefgh', ['abcdefgz'], 0)).toBeUndefined();
    // a generous budget lets a farther word through
    expect(nearest('abcdefgh', ['abcdefgz'], 5)).toBe('abcdefgz');
  });
});

describe('didYouMean', () => {
  it('appends a single suggestion for a near miss', () => {
    expect(didYouMean('nam', ['name', 'age', 'email'])).toBe(' — did you mean `name`?');
  });

  it('returns an empty string for a far miss or empty candidates', () => {
    expect(didYouMean('somethingelse', ['name', 'age'])).toBe('');
    expect(didYouMean('name', [])).toBe('');
  });

  it('caps at `max` suggestions and lists them (or / Oxford comma)', () => {
    // two equidistant single-char candidates ⇒ "`a` or `b`"
    expect(didYouMean('x', ['a', 'b'], { max: 2 })).toBe(' — did you mean `a` or `b`?');
    // three equidistant candidates ⇒ Oxford-comma list (order preserved on a tie)
    expect(didYouMean('x', ['a', 'b', 'c'], { max: 3 })).toBe(
      ' — did you mean `a`, `b`, or `c`?',
    );
    // max clamps to at least 1 even when 0 is asked for
    expect(didYouMean('nam', ['name', 'nane'], { max: 0 })).toBe(' — did you mean `name`?');
  });

  it('is case-insensitive (a wrong-case value still suggests the canonical spelling)', () => {
    expect(didYouMean('ASC', ['asc', 'desc'])).toBe(' — did you mean `asc`?');
  });
});

describe('directedMessage', () => {
  it('invalid_type → expected <label>[, got <received>]', () => {
    expect(directedMessage(typeIssue('oops'), 'Expr', undefined)).toBe(
      'expected an expression, got a string',
    );
    // A missing value (undefined input) drops the ", got …" tail.
    expect(directedMessage(typeIssue(undefined), 'FunctionArgs', undefined)).toBe(
      'expected named arguments, an object of { argName: <expr> }',
    );
  });

  it('invalid_value → expected <label>: <allowed>', () => {
    expect(directedMessage(valueIssue(['=', '<>', '<'], 'equals'), 'ComparisonOp', undefined)).toBe(
      'expected a comparison operator: =, <>, <',
    );
  });

  it('invalid_value appends a "did you mean" for a near-miss enum value', () => {
    // A case/spelling near-miss of an allowed op is suggested.
    expect(
      directedMessage(valueIssue(['like', 'notLike', 'ilike'], 'notlike'), 'ComparisonOp', undefined),
    ).toBe('expected a comparison operator: like, notLike, ilike — did you mean `notLike`?');
    // A wrong-case direction still resolves to the canonical spelling.
    expect(directedMessage(valueIssue(['asc', 'desc'], 'ASC'), 'OrderDir', undefined)).toBe(
      'expected a sort direction (asc or desc): asc, desc — did you mean `asc`?',
    );
  });

  it('invalid_value adds no suggestion for a non-string value or a far miss', () => {
    // A non-string received value ⇒ no suggestion computed.
    expect(directedMessage(valueIssue(['asc', 'desc'], 5), 'OrderDir', undefined)).toBe(
      'expected a sort direction (asc or desc): asc, desc',
    );
    // A far-off string ⇒ no false suggestion.
    expect(directedMessage(valueIssue(['asc', 'desc'], 'sideways'), 'OrderDir', undefined)).toBe(
      'expected a sort direction (asc or desc): asc, desc',
    );
  });

  it('invalid_union → unknown-kind suggestion, else the union label', () => {
    expect(directedMessage(unionIssue({ kind: 'comparise' }), 'Expr', ['comparison', 'logical'])).toBe(
      'unknown expression kind `comparise` — did you mean `comparison`? (available: comparison, logical)',
    );

    // No `kind` string on the value ⇒ the plain "expected <label>".
    expect(directedMessage(unionIssue('three'), 'Limit', undefined)).toBe('expected a number or a param');

    // A union WITH kinds but a far-off word lists availability without a guess.
    expect(directedMessage(unionIssue({ kind: 'zzzzzzzz' }), 'Query', ['select', 'insert'])).toBe(
      'unknown query kind `zzzzzzzz` (available: select, insert)',
    );

    // A union node whose aid has no `noun` uses the generic "value".
    expect(directedMessage(unionIssue({ kind: 'nope' }), 'Join', ['a', 'b'])).toContain(
      'unknown value kind `nope`',
    );
  });

  it('unknown-kind guard rejects non-record / missing-kind / no-kinds inputs', () => {
    // kinds absent
    expect(directedMessage(unionIssue({ kind: 'x' }), 'Expr', undefined)).toBe('expected an expression');
    // kinds empty
    expect(directedMessage(unionIssue({ kind: 'x' }), 'Expr', [])).toBe('expected an expression');
    // input is an array (not a record)
    expect(directedMessage(unionIssue([1]), 'Expr', ['comparison'])).toBe('expected an expression');
    // input.kind is not a string
    expect(directedMessage(unionIssue({ kind: 7 }), 'Expr', ['comparison'])).toBe('expected an expression');
  });

  it('any other code → a safe expected-<label> fallback', () => {
    expect(directedMessage(otherIssue(5), 'Limit', undefined)).toBe('expected a number or a param');
  });
});

describe('withAid', () => {
  it('attaches the aid to meta and a directed error to the schema', () => {
    const s = withAid(z.enum(['asc', 'desc']), 'OrderDir').describe('dir');
    expect(s.meta()?.aid).toBe('OrderDir');
    expect(s.meta()?.description).toBe('dir');
    const err = s.safeParse('sideways').error!;
    expect(err.issues[0]!.message).toBe('expected a sort direction (asc or desc): asc, desc');
  });

  it('drives the "did you mean" suggestion off the union kinds', () => {
    const a = z.object({ kind: z.literal('comparison') });
    const b = z.object({ kind: z.literal('logical') });
    const union = withAid(a.or(b), 'Expr', { kinds: ['comparison', 'logical'] });
    const err = union.safeParse({ kind: 'compariso' }).error!;
    expect(err.issues[0]!.message).toContain('did you mean `comparison`');
  });
});
