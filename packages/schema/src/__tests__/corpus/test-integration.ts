/**
 * @aeye/test-integration's live schema fixtures (packages/test-integration/src/schemas.ts and the
 * schemas in its live tests), ported to `a`: the shapes the strict dialects disagree on, and the
 * shapes past each provider's limits.
 */
import { expectTypeOf } from 'expect-type';
import { a, type JsonValue } from '../../index';

// test-integration:schemas.ts:8
export const identifiers = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}_${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'][i % 6]}_${i}`);

// test-integration:schemas.ts:11 — `z.lazy(...).meta({ id: 'Category' })`.
export interface Category { name: string; children?: Category[] }
export const CategoryModule = a.define({
  Category: a.object({
    name: a.string().describe('Category name'),
    children: a.array(a.ref('Category')).optional().describe('Sub-categories'),
  }),
});

// test-integration:schemas.ts:20
export const Address = a.object({
  street: a.string().min(1).max(200),
  city: a.string(),
  postcode: a.string().pattern(/^[0-9]{5}$/).describe('Five digit postcode'),
  country: a.enum(['US', 'CA', 'MX', 'GB', 'DE', 'FR']),
});
export type AddressT = { street: string; city: string; postcode: string; country: 'US' | 'CA' | 'MX' | 'GB' | 'DE' | 'FR' };
expectTypeOf<a.infer<typeof Address>>().toEqualTypeOf<AddressT>();

/** test-integration:schemas.ts:30 — everything the dialects disagree on, in one schema. */
const complexShape = {
  id: a.string().format('uuid').describe('Order id'),
  createdAt: a.string().format('date-time'),
  contact: a.string().format('email'),
  status: a.enum(['draft', 'placed', 'shipped', 'delivered', 'cancelled']),
  sku: a.enum(identifiers('sku', 120)).describe('Product code'),
  quantity: a.int().min(1).max(99),
  discount: a.number().min(0).max(1).nullable(),
  note: a.string().max(500).optional(),
  tags: a.array(a.string()).min(1).max(5),
  shipping: Address,
  billing: Address.nullable(),
  lines: a.array(a.object({
    sku: a.string(),
    price: a.number().positive(),
    options: a.array(a.object({ key: a.string(), value: a.union([a.string(), a.number(), a.boolean()]) })),
  })).max(20),
  payment: a.discriminatedUnion('kind', [
    a.object({ kind: a.literal('card'), last4: a.string().pattern(/^\d{4}$/) }),
    a.object({ kind: a.literal('invoice'), dueDays: a.int().min(0).max(90) }),
  ]),
  attributes: a.record(a.string()).describe('Free-form attributes'),
  category: a.ref('Category'),
  deep: a.object({ a: a.object({ b: a.object({ c: a.object({ d: a.object({ e: a.string() }) }) }) }) }),
} as const;
export const Complex = CategoryModule.result(a.object(complexShape));
// live-bedrock.test.ts:248 `fixtures.complex.omit({ category: true })`
const { category: _category, ...flatShape } = complexShape;
export const ComplexFlat = a.object(flatShape);

export type ComplexT = {
  id: string; createdAt: string; contact: string;
  status: 'draft' | 'placed' | 'shipped' | 'delivered' | 'cancelled';
  sku: string; quantity: number; discount: number | null; note?: string; tags: string[];
  shipping: AddressT; billing: AddressT | null;
  lines: { sku: string; price: number; options: { key: string; value: string | number | boolean }[] }[];
  payment: { kind: 'card'; last4: string } | { kind: 'invoice'; dueDays: number };
  attributes: Record<string, string>;
  category: Category;
  deep: { a: { b: { c: { d: { e: string } } } } };
};
expectTypeOf<a.infer<typeof Complex>>().toEqualTypeOf<ComplexT>();
expectTypeOf<a.infer<typeof ComplexFlat>>().toEqualTypeOf<Omit<ComplexT, 'category'>>();

// test-integration:schemas.ts:60 — over 250 values: OpenAI's large-enum rule and Gemini's enum cap.
export const LargeEnum = a.object({ pick: a.enum(identifiers('component', 300)) });
expectTypeOf<a.infer<typeof LargeEnum>>().toEqualTypeOf<{ pick: string }>();

// test-integration:schemas.ts:62 — over OpenAI's 10 levels of nesting.
export const TooDeep = a.object({ a: a.object({ b: a.object({ c: a.object({ d: a.object({ e: a.object({ f: a.object({
  g: a.object({ h: a.object({ i: a.object({ j: a.object({ k: a.string() }) }) }) }),
}) }) }) }) }) }) });
expectTypeOf<a.infer<typeof TooDeep>>().toEqualTypeOf<{ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: string } } } } } } } } } } }>();

// test-integration:schemas.ts:67 — over Anthropic's 24 optional parameters.
export const ManyOptional = a.object(Object.fromEntries(identifiers('field', 30).map((n) => [n, a.string().optional()])));
// The keys are runtime data: the type is a string-keyed object of optional strings.

// test-integration:schemas.ts:69 — any values, tuples and open records.
export const AnyTuple = a.object({
  payload: a.json(), // z.any()
  extra: a.record(a.unknown()),
  point: a.tuple([a.number(), a.number(), a.string()]),
});
expectTypeOf<a.infer<typeof AnyTuple>>().toEqualTypeOf<{ payload: JsonValue; extra: Record<string, unknown>; point: [number, number, string] }>();

// test-integration:schemas.ts:79 — over Anthropic's 16 union-typed parameters per request.
export const ManyUnions = a.object(Object.fromEntries(identifiers('choice', 20).map((n) => [n, a.union([a.string(), a.number()])])));

// test-integration:reasoning.ts:142
export const DiceCount = a.object({ count: a.number().describe('How many dice to roll') });
expectTypeOf<a.infer<typeof DiceCount>>().toEqualTypeOf<{ count: number }>();

// test-integration:live-bedrock.test.ts:279
export const City = a.object({ city: a.string(), code: a.enum(['FR', 'DE', 'ES']) });
expectTypeOf<a.infer<typeof City>>().toEqualTypeOf<{ city: string; code: 'FR' | 'DE' | 'ES' }>();

// test-integration:prompt-features.test.ts:25 — `z.string().meta({ not: { const: 'black' } })` (OpenAI strict rejects `not`).
export const NotBlack = a.object({ color: a.not(a.literal('black'), a.string()) });
expectTypeOf<a.infer<typeof NotBlack>>().toEqualTypeOf<{ color: string }>();

// test-integration:schema-resolution.test.ts:28
export const Answer = a.object({ answer: a.string() });
