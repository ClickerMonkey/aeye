/**
 * The tool parameters / response formats in @aeye/ai and the provider packages
 * (@aeye/openai, @aeye/openrouter, @aeye/aws), ported to `a`. These packages
 * take core's schemas through; their own schemas are test fixtures for
 * dialect choice, fallbacks and decoding.
 */
import { expectTypeOf } from 'expect-type';
import { a } from '../../index';

// ai:schema-fallback.test.ts:30 — a union (Google strict has taken unions since Nov 2025).
export const UnionValue = a.object({ id: a.string(), value: a.union([a.string(), a.number()]) });
expectTypeOf<a.infer<typeof UnionValue>>().toEqualTypeOf<{ id: string; value: string | number }>();
// ai:schema-fallback.test.ts:37 — an intersection (allOf; core: Google strict can't take it).
export const AllOfValue = a.object({ id: a.string(), value: a.intersection([a.object({ a: a.string() }), a.object({ b: a.number() })]) });
expectTypeOf<a.infer<typeof AllOfValue>>().toEqualTypeOf<{ id: string; value: { a: string } & { b: number } }>();
// ai:schema-fallback.test.ts:42
export const Plain = a.object({ id: a.string(), name: a.string() });
// ai:chat-strict.test.ts:43
export const XArgs = a.object({ x: a.string() });
// ai:tool-decoded.test.ts:38/70/83 and :106
export const WhoArgs = a.object({ who: a.string() });
export const NArgs = a.object({ n: a.number() });
// ai:chat-output-capabilities.test.ts:22, runtime-schema-fallback.test.ts:71, tool-decoded.test.ts:138,
// openai:schema-rejection.test.ts:42/54, openrouter:schema-rejection.test.ts:28, aws:schema-delivery.test.ts:22
export const ValueOutput = a.object({ value: a.number() });

// openai:openai.test.ts:190/745/774/886 and responses.test.ts:70/108/268 (city), openai.ts:355 (doc)
export const LocationArgs = a.object({ location: a.string() });
export const CityArgs = a.object({ city: a.string() });
// openai:openai.test.ts:713
export const WeatherArgs = a.object({ location: a.string(), unit: a.enum(['celsius', 'fahrenheit']) });
expectTypeOf<a.infer<typeof WeatherArgs>>().toEqualTypeOf<{ location: string; unit: 'celsius' | 'fahrenheit' }>();
// openai:openai.test.ts:799
export const ResultOutput = a.object({ result: a.string() });
// openai:schema-rejection.test.ts:20, aws:converse.test.ts:213/294/311, aws:schema-delivery.test.ts:36
export const QArgs = a.object({ q: a.string() });
// openrouter:openrouter.test.ts:42/47/146
export const QueryOutput = a.object({ query: a.string() });

// openrouter:openrouter.test.ts:218 — the `api_signature` tool: a named object that also takes any extra JSON
//   signature: z.object({ name: z.string() }).catchall(z.any()).describe(...)
export const ApiSignatureArgs = a.object({
  signature: a.object({ name: a.string() }).rest(a.json()).describe('The signature of the API function being declared.'),
});

// aws:aws.test.ts:404 — a recursive tool (z.lazy).
export type Node = { value: string; children?: Node[] };
export const WalkTree = a.define({ Node: a.object({ value: a.string(), children: a.array(a.ref('Node')).optional() }) }).result('Node');
expectTypeOf<a.infer<typeof WalkTree>>().toEqualTypeOf<Node>();

// aws:aws.test.ts:464 — a shared (non-recursive) named type, `.meta({ aid: 'Person' })`.
export const Attribute = a
  .define({ Person: a.object({ name: a.string(), age: a.number() }) })
  .result(a.object({ author: a.ref('Person'), reviewer: a.ref('Person') }));
expectTypeOf<a.infer<typeof Attribute>>().toEqualTypeOf<{ author: { name: string; age: number }; reviewer: { name: string; age: number } }>();

// aws:converse.test.ts:233 — structured output with an optional array.
export const TitleTags = a.object({ title: a.string(), tags: a.array(a.string()).optional() });
expectTypeOf<a.infer<typeof TitleTags>>().toEqualTypeOf<{ title: string; tags?: string[] }>();
