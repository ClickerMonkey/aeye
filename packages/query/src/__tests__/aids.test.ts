/**
 * Unit coverage for the aid-directed messages (`src/aids.ts`): `describeInput`,
 * the edit-distance "did you mean" suggestion, and the `AID_REGISTRY` fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  aidInfo,
  describeInput,
  editDistance,
  nearestKind,
  nearest,
  didYouMean,
  suggestionBudget,
  AID_REGISTRY,
} from '../aids';

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

