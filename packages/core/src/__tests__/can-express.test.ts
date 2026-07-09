/**
 * Tests for `canExpress` — whether a Zod schema can be expressed as structured
 * output under a given descriptor's dialect — and the robust `extractJSONObject`
 * used by the prompt-text schema-delivery fallback.
 */

import { z } from 'zod';
import {
  canExpress,
  extractJSONObject,
  GOOGLE_STRICT,
  OPENAI_STRICT,
  ANTHROPIC_STRICT,
  LENIENT,
} from '../index';

describe('canExpress', () => {
  describe('unions (anyOf)', () => {
    const unionSchema = z.union([z.string(), z.number()]);

    it('is false under GOOGLE_STRICT (allowAnyOf: false)', () => {
      expect(canExpress(unionSchema, GOOGLE_STRICT)).toBe(false);
    });

    it('is true under OPENAI_STRICT (allowAnyOf: true)', () => {
      expect(canExpress(unionSchema, OPENAI_STRICT)).toBe(true);
    });

    it('is true under LENIENT', () => {
      expect(canExpress(unionSchema, LENIENT)).toBe(true);
    });

    it('detects a union nested inside an object under GOOGLE_STRICT', () => {
      const schema = z.object({
        id: z.string(),
        value: z.union([z.string(), z.number()]),
      });
      expect(canExpress(schema, GOOGLE_STRICT)).toBe(false);
      expect(canExpress(schema, OPENAI_STRICT)).toBe(true);
    });

    it('treats a discriminated union as anyOf', () => {
      const schema = z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), a: z.string() }),
        z.object({ kind: z.literal('b'), b: z.number() }),
      ]);
      expect(canExpress(schema, GOOGLE_STRICT)).toBe(false);
      expect(canExpress(schema, OPENAI_STRICT)).toBe(true);
    });

    it('does NOT treat nullable/optional as a union', () => {
      const schema = z.object({
        a: z.string().nullable(),
        b: z.number().optional(),
      });
      expect(canExpress(schema, GOOGLE_STRICT)).toBe(true);
    });
  });

  describe('recursion / $ref', () => {
    it('allows a ROOT self-recursive schema under GOOGLE_STRICT (allowRootRef)', () => {
      const Node: z.ZodType = z.object({
        value: z.string(),
        children: z.array(z.lazy(() => Node)),
      });
      // Root self-reference → `$ref: '#'`, which Gemini supports.
      expect(canExpress(Node, GOOGLE_STRICT)).toBe(true);
    });

    it('rejects a NON-root recursive $ref under GOOGLE_STRICT (allowDefsRef: false)', () => {
      const Inner: z.ZodType = z.object({
        label: z.string(),
        next: z.lazy(() => Inner),
      });
      const Root = z.object({ inner: Inner });
      expect(canExpress(Root, GOOGLE_STRICT)).toBe(false);
    });

    it('allows a NON-root recursive $ref under a descriptor with allowDefsRef + supportsRecursion', () => {
      const Inner: z.ZodType = z.object({
        label: z.string(),
        next: z.lazy(() => Inner),
      });
      const Root = z.object({ inner: Inner });
      expect(canExpress(Root, LENIENT)).toBe(true);
    });

    it('rejects a root self-recursive schema when the descriptor lacks recursion (ANTHROPIC_STRICT)', () => {
      // ANTHROPIC_STRICT: allowRootRef false, supportsRecursion false.
      const Node: z.ZodType = z.object({
        value: z.string(),
        children: z.array(z.lazy(() => Node)),
      });
      expect(canExpress(Node, ANTHROPIC_STRICT)).toBe(false);
    });
  });

  describe('plain schemas', () => {
    const plain = z.object({
      name: z.string(),
      age: z.number(),
      tags: z.array(z.string()),
      meta: z.object({ active: z.boolean() }),
    });

    it('is true for every descriptor', () => {
      for (const d of [GOOGLE_STRICT, OPENAI_STRICT, ANTHROPIC_STRICT, LENIENT]) {
        expect(canExpress(plain, d)).toBe(true);
      }
    });
  });
});

describe('extractJSONObject', () => {
  it('returns clean JSON verbatim', () => {
    const clean = JSON.stringify({ a: 1, b: 'two', c: { d: true } });
    expect(extractJSONObject(clean)).toBe(clean);
  });

  it('strips markdown ```json fences', () => {
    const obj = { name: 'x', value: 42 };
    const fenced = '```json\n' + JSON.stringify(obj) + '\n```';
    expect(JSON.parse(extractJSONObject(fenced))).toEqual(obj);
  });

  it('strips plain ``` fences', () => {
    const obj = { ok: true };
    const fenced = '```\n' + JSON.stringify(obj) + '\n```';
    expect(JSON.parse(extractJSONObject(fenced))).toEqual(obj);
  });

  it('extracts JSON from surrounding prose', () => {
    const obj = { answer: 'yes' };
    const prose = `Sure! Here is the result: ${JSON.stringify(obj)} — hope that helps.`;
    expect(JSON.parse(extractJSONObject(prose))).toEqual(obj);
  });

  it('handles braces inside string literals', () => {
    const obj = { template: 'a {curly} brace }', nested: { x: '}}}' } };
    const text = 'Result: ' + JSON.stringify(obj);
    expect(JSON.parse(extractJSONObject(text))).toEqual(obj);
  });

  it('handles escaped quotes inside strings', () => {
    const obj = { quote: 'she said "hi" }', k: 1 };
    expect(JSON.parse(extractJSONObject(JSON.stringify(obj)))).toEqual(obj);
  });

  it('takes the outermost balanced object when trailing text follows', () => {
    const obj = { a: 1 };
    const text = JSON.stringify(obj) + '\nsome trailing note { not: json';
    expect(JSON.parse(extractJSONObject(text))).toEqual(obj);
  });

  it("returns '' when there is no object (matches the prior extractor)", () => {
    expect(extractJSONObject('no json here')).toBe('');
  });
});
