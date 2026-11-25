/**
 * Schema fixtures for live acceptance cases: shapes the strict dialects
 * disagree on, and shapes past each provider's limits. Bound once (they are
 * static), ready for `ToolDefinition.parameters` / `ResponseFormat.type`.
 */

import { a } from '@aeye/schema';
import type { Bound } from '@aeye/core';

const identifiers = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}_${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'][i % 6]}_${i}`);

const address = a.object({
  street: a.string().min(1).max(200),
  city: a.string(),
  postcode: a.string().pattern(/^[0-9]{5}$/).describe('Five digit postcode'),
  country: a.enum(['US', 'CA', 'MX', 'GB', 'DE', 'FR']),
});

/**
 * Everything the dialects disagree on but recursion, in one shape.
 */
const flatShape = {
  id: a.string().format('uuid').describe('Order id'),
  createdAt: a.string().format('date-time'),
  contact: a.string().format('email'),
  status: a.enum(['draft', 'placed', 'shipped', 'delivered', 'cancelled']),
  sku: a.enum(identifiers('sku', 120)).describe('Product code'),
  quantity: a.int().min(1).max(99),
  discount: a.number().min(0).max(1).nullable(),
  note: a.string().max(500).optional(),
  tags: a.array(a.string()).min(1).max(5),
  shipping: address,
  billing: address.nullable(),
  lines: a.array(a.object({
    sku: a.string(),
    price: a.number().positive(),
    options: a.array(a.object({
      key: a.string(),
      value: a.union([a.string(), a.number(), a.boolean()]),
    })),
  })).max(20),
  payment: a.discriminatedUnion('kind', [
    a.object({ kind: a.literal('card'), last4: a.string().pattern(/^\d{4}$/) }),
    a.object({ kind: a.literal('invoice'), dueDays: a.int().min(0).max(90) }),
  ]),
  attributes: a.record(a.string()).describe('Free-form attributes'),
  deep: a.object({ a: a.object({ b: a.object({ c: a.object({ d: a.object({ e: a.string() }) }) }) }) }),
};

/**
 * Everything the dialects disagree on, in one schema: the flat shape plus a
 * recursive named `Category`.
 */
const complex = a
  .define({
    Category: a.object({
      name: a.string().describe('Category name'),
      children: a.array(a.ref('Category')).optional().describe('Sub-categories'),
    }),
  })
  .result(a.object({ ...flatShape, category: a.ref('Category') }));

/** `complex` without its recursive part. */
export const complexFlat: Bound<any> = a.object(flatShape).bind();

export const fixtures: Record<string, Bound<any>> = {
  complex: complex.bind(),
  // Over 250 values: OpenAI's large-enum rule and Gemini's enum cap
  'large-enum': a.object({ pick: a.enum(identifiers('component', 300)) }).bind(),
  // Over OpenAI's 10 levels of nesting
  'too-deep': a.object({ a: a.object({ b: a.object({ c: a.object({ d: a.object({ e: a.object({ f: a.object({
    g: a.object({ h: a.object({ i: a.object({ j: a.object({ k: a.string() }) }) }) }),
  }) }) }) }) }) }) }).bind(),
  // Over Anthropic's 24 optional parameters
  'many-optional': a.object(Object.fromEntries(identifiers('field', 30).map(name => [name, a.string().optional()]))).bind(),
  // Any values, tuples and open records
  'any-tuple': a.object({
    payload: a.unknown(),
    extra: a.record(a.unknown()),
    point: a.tuple([a.number(), a.number(), a.string()]),
  }).bind(),
};

/**
 * Over Anthropic's 16 union-typed parameters per request.
 */
export const manyUnions: Bound<any> = a.object(Object.fromEntries(identifiers('choice', 20).map(name => [name, a.union([a.string(), a.number()])]))).bind();
