/**
 * Schema fixtures for live acceptance cases: shapes the strict dialects
 * disagree on, and shapes past each provider's limits.
 */

import z from 'zod';

const identifiers = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}_${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'][i % 6]}_${i}`);

interface Category {
  name: string;
  children?: Category[];
}
const category: z.ZodType<Category> = z.lazy(() => z.object({
  name: z.string().describe('Category name'),
  children: z.array(category).optional().describe('Sub-categories'),
})).meta({ id: 'Category' });

const address = z.object({
  street: z.string().min(1).max(200),
  city: z.string(),
  postcode: z.string().regex(/^[0-9]{5}$/).describe('Five digit postcode'),
  country: z.enum(['US', 'CA', 'MX', 'GB', 'DE', 'FR']),
});

/**
 * Everything the dialects disagree on, in one schema.
 */
const complex = z.object({
  id: z.uuid().describe('Order id'),
  createdAt: z.iso.datetime(),
  contact: z.email(),
  status: z.enum(['draft', 'placed', 'shipped', 'delivered', 'cancelled']),
  sku: z.enum(identifiers('sku', 120)).describe('Product code'),
  quantity: z.int().min(1).max(99),
  discount: z.number().min(0).max(1).nullable(),
  note: z.string().max(500).optional(),
  tags: z.array(z.string()).min(1).max(5),
  shipping: address,
  billing: address.nullable(),
  lines: z.array(z.object({
    sku: z.string(),
    price: z.number().positive(),
    options: z.array(z.object({
      key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })),
  })).max(20),
  payment: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('card'), last4: z.string().regex(/^\d{4}$/) }),
    z.object({ kind: z.literal('invoice'), dueDays: z.int().min(0).max(90) }),
  ]),
  attributes: z.record(z.string(), z.string()).describe('Free-form attributes'),
  category,
  deep: z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.object({ e: z.string() }) }) }) }) }),
});

export const fixtures = {
  complex,
  // Over 250 values: OpenAI's large-enum rule and Gemini's enum cap
  'large-enum': z.object({ pick: z.enum(identifiers('component', 300)) }),
  // Over OpenAI's 10 levels of nesting
  'too-deep': z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.object({ e: z.object({ f: z.object({
    g: z.object({ h: z.object({ i: z.object({ j: z.object({ k: z.string() }) }) }) }),
  }) }) }) }) }) }) }),
  // Over Anthropic's 24 optional parameters
  'many-optional': z.object(Object.fromEntries(identifiers('field', 30).map(name => [name, z.string().optional()]))),
  // Any values, tuples and open records
  'any-tuple': z.object({
    payload: z.any(),
    extra: z.record(z.string(), z.unknown()),
    point: z.tuple([z.number(), z.number(), z.string()]),
  }),
};

/**
 * Over Anthropic's 16 union-typed parameters per request.
 */
export const manyUnions = z.object(Object.fromEntries(identifiers('choice', 20).map(name => [name, z.union([z.string(), z.number()])])));
