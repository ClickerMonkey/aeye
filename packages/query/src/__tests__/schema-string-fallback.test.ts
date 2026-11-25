/**
 * querySchema / shouldUseStringSchema — past the Type-count threshold the
 * structured schema is abandoned for a `{ query: z.string() }` fallback.
 */
import { describe, it, expect } from 'vitest';
import { querySchema, shouldUseStringSchema } from '../llm/schemas';
import { fixture, accepts, decode } from './_utils';

describe('shouldUseStringSchema', () => {
  it('is false at or below the max, true above it', () => {
    const fx = fixture();
    const types = fx.registry.typeList();
    expect(shouldUseStringSchema(types, 5)).toBe(false);
    expect(shouldUseStringSchema(types, 1)).toBe(true);
  });
});

describe('querySchema', () => {
  it('returns a structured query object schema within the threshold', () => {
    const fx = fixture();
    const schema = querySchema(fx.engine);
    const structured = decode(schema, {
      query: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
        from: { kind: 'type', type: 'user' },
      },
    });
    expect(structured.ok).toBe(true);
    // A bare string is NOT accepted by the structured schema.
    expect(accepts(schema, { query: 'just prose' })).toBe(false);
  });

  it('falls back to a string query past the threshold', () => {
    const fx = fixture();
    const schema = querySchema(fx.engine, { max: 1 });
    expect(accepts(schema, { query: 'find all orders over $100 for London users' })).toBe(
      true,
    );
    // A structured object is NOT accepted by the string fallback.
    expect(accepts(schema, { query: { kind: 'select' } })).toBe(false);
  });
});
