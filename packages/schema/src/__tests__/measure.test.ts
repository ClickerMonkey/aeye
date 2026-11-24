/**
 * What a provider's limits count, measured on the emitted JSON; and the
 * format / pattern checks that back what dialects can't enforce.
 */
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, isBasicPattern, LENIENT, measureJson, OPENAI_STRICT, overLimits } from '../index';

describe('measureJson', () => {
  it('counts properties, optionals, unions, enums, characters and depth (following $refs)', () => {
    const m = measureJson({
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['a', 'bb'] },
        maybe: { type: ['string', 'null'] },
        node: { $ref: '#/$defs/Node' },
      },
      required: ['name', 'kind'],
      $defs: {
        Node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/Node' } }, c: { const: 'xyz' } }, required: ['kids'] },
      },
    });
    expect(m).toEqual({
      properties: 6, // name kind maybe node + kids c
      depth: 3, // root → Node → kids (the cycle stops)
      stringChars: 4 + 4 + 5 + 4 + 4 + 1 + 3 + 3 + 4, // names, enum values, const, $defs name
      enumValues: 2,
      enums: [{ values: 2, chars: 3 }],
      optional: 3, // maybe, node, c
      unions: 1, // the type array
    });
  });

  it('is exact per profile: pairs count key/value, widened enums count nothing, nulls count as unions', () => {
    const S = a.object({ limits: a.record(a.number()), pick: a.enum(['x', 'y']), note: a.string().optional() });
    expect(S.render(LENIENT).measure).toMatchObject({ properties: 3, optional: 1, unions: 0, enumValues: 2 });
    expect(S.render(OPENAI_STRICT).measure).toMatchObject({ properties: 5, optional: 0, unions: 1, enumValues: 2 });
    expect(S.render(ANTHROPIC_STRICT).measure).toMatchObject({ properties: 5, optional: 1, unions: 0 });
    expect(S.render(OPENAI_STRICT).measure).toBe(S.render(OPENAI_STRICT).measure);
  });

  it('overLimits names each broken limit', () => {
    const m = measureJson({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } });
    expect(overLimits(m, { maxProperties: 1, maxOptional: 1 }, '"t"')).toEqual(['"t": 2 object properties (limit 1)', '"t": 2 optional properties (limit 1)']);
    expect(overLimits(m, undefined, 'x')).toEqual([]);
  });
});

describe('formats and patterns', () => {
  it.each([
    ['date-time', '2026-11-24T10:00:00Z', '24/11/2026'],
    ['date', '2026-11-24', '2026-11-24T10:00'],
    ['time', '10:00:30', '10am'],
    ['duration', 'P1DT2H', 'PT'],
    ['email', 'a@b.co', 'a@b'],
    ['uuid', '123e4567-e89b-12d3-a456-426614174000', '123e4567'],
    ['uri', 'https://x.y/z', 'not a uri'],
    ['hostname', 'api.example.com', '-bad-.com'],
    ['ipv4', '10.0.0.1', '10.0.0.256'],
    ['ipv6', '::1', '1:::2:3'],
  ])('%s: %s passes, %s fails', (format, good, bad) => {
    const r = a.object({ v: a.string().format(format) }).render(LENIENT);
    expect(r.parse({ v: good }).ok).toBe(true);
    expect(r.parse({ v: bad })).toMatchObject({ ok: false, issues: [{ message: `Must be a valid ${format}.` }] });
  });

  it('an unknown format is passed through, not checked', () => {
    expect(a.object({ v: a.string().format('color') }).render(LENIENT).parse({ v: 'anything' }).ok).toBe(true);
  });

  it('isBasicPattern: the subset strict providers compile', () => {
    expect(isBasicPattern('^[a-z]+\\d{2,5}$')).toBe(true);
    for (const p of ['(?=x)', '(?<!x)', '\\bword', '(a)\\1', '\\p{L}', 'a{1,500}']) expect(isBasicPattern(p)).toBe(false);
  });
});
