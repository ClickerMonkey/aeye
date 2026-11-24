/**
 * COMPILE-TIME proofs for the features added after the POC: the produced
 * type of every new schema class, request entries typed by name, encoders,
 * template helpers, profiles and gin's and/not/iface. Type-checked by
 * `npm run test:types` (exactOptionalPropertyTypes, noUncheckedIndexedAccess);
 * every `@ts-expect-error` must be an error or tsc fails.
 */
import { expectTypeOf } from 'expect-type';
import {
  a, fromGin, LENIENT, ModelProfile, OPENAI_STRICT, profileFor, schemaHelpers,
  type Encoder, type HelperSet, type ModelLike, type ParseResult, type Profile, type RenderedRequest, type RequestEntry,
} from '../index';

// ---------------------------------------------------------------------------
// Intersections, not, conditional
// ---------------------------------------------------------------------------

const Both = a.intersection([a.object({ name: a.string() }), a.object({ at: a.string(), n: a.int().optional() })]);
expectTypeOf<a.infer<typeof Both>>().toEqualTypeOf<{ name: string } & { at: string; n?: number }>();
const Three = a.intersection([a.object({ a: a.number() }), a.object({ b: a.boolean() }), a.object({ c: a.null() })]);
expectTypeOf<a.infer<typeof Three>>().toMatchTypeOf<{ a: number; b: boolean; c: null }>();

const NotX = a.not(a.literal('x'), a.string());
expectTypeOf<a.infer<typeof NotX>>().toEqualTypeOf<string>();
const NotAny = a.not(a.number());
expectTypeOf<a.infer<typeof NotAny>>().toEqualTypeOf<unknown>();

const Cond = a.conditional(a.object({ country: a.string(), zip: a.string() }), { if: a.object({ country: a.literal('US') }), then: a.object({ zip: a.string().pattern('^\\d{5}$') }) });
expectTypeOf<a.infer<typeof Cond>>().toEqualTypeOf<{ country: string; zip: string }>();

// ---------------------------------------------------------------------------
// A value typed by a sibling
// ---------------------------------------------------------------------------

const CreateVar = a.object({ name: a.string(), type: a.enum(['num', 'text']) }).dependent('value', 'type', (t) => {
  // The sibling's decoded type flows into the callback.
  expectTypeOf(t).toEqualTypeOf<'num' | 'text'>();
  return t === 'num' ? a.number() : a.string();
});
expectTypeOf<a.infer<typeof CreateVar>>().toEqualTypeOf<{ name: string; type: 'num' | 'text'; value: unknown }>();
// A base schema types the value.
const Typed = a.object({ kind: a.literal('n') }).dependent('value', 'kind', () => a.int(), a.json());
expectTypeOf<a.infer<typeof Typed>['value']>().toEqualTypeOf<import('../types').JsonValue>();
// @ts-expect-error — the sibling must be a field of the object.
a.object({ type: a.string() }).dependent('value', 'nope', () => undefined);

// ---------------------------------------------------------------------------
// Extra keys
// ---------------------------------------------------------------------------

const Headers = a.object({ id: a.string() }).rest(a.number());
expectTypeOf<a.infer<typeof Headers>>().toEqualTypeOf<{ id: string } & { [key: string]: number }>();
const Ext = a.object({ id: a.string() }).patterns({ '^x-': a.string() });
expectTypeOf<a.infer<typeof Ext>['anything']>().toEqualTypeOf<unknown>();
expectTypeOf<a.infer<typeof Ext>['id']>().toEqualTypeOf<string>();
// A plain object has no index signature.
const Plain = a.object({ id: a.string() });
// @ts-expect-error — no extra keys on a plain object.
const _p: a.infer<typeof Plain> = { id: 'x', other: 1 };

// ---------------------------------------------------------------------------
// gin and / not / iface
// ---------------------------------------------------------------------------

const GinAnd = fromGin({ name: 'and', options: { types: [
  { name: 'obj', props: { a: { type: { name: 'num' } } } },
  { name: 'obj', props: { b: { type: { name: 'text' } } } },
] } } as const);
expectTypeOf<a.infer<typeof GinAnd>>().toEqualTypeOf<{ a: number } & { b: string }>();
const GinIface = fromGin({ name: 'iface', props: { title: { type: { name: 'text' } } } } as const);
expectTypeOf<a.infer<typeof GinIface>>().toEqualTypeOf<{ title: string }>();
const GinNot = fromGin({ name: 'not', options: { excluded: { name: 'num' } } } as const);
expectTypeOf<a.infer<typeof GinNot>>().toEqualTypeOf<unknown>();

// ---------------------------------------------------------------------------
// Requests: entries typed by name
// ---------------------------------------------------------------------------

const Search = a.object({ query: a.string(), limit: a.int().optional() });
const Report = a.object({ title: a.string(), scores: a.record(a.number()) });
const Rows = a.define({ Row: a.object({ f: a.ref('Field') }) })
  .dynamic((fields: [string, ...string[]]) => ({ Field: a.enum(fields) }))
  .result(a.array(a.ref('Row')));

const req = ModelProfile.of(OPENAI_STRICT).request([
  { kind: 'tool', name: 'search', schema: Search },
  { kind: 'tool', name: 'rows', schema: Rows.bind(['a']) },
  { kind: 'output', schema: Report },
]);
expectTypeOf(req.entries).toEqualTypeOf<readonly RequestEntry<any>[]>();
const _asAny: RenderedRequest<any> = req;
expectTypeOf(req.get('search')).toEqualTypeOf<RequestEntry<{ query: string; limit?: number }>>();
expectTypeOf(req.get('rows')).toEqualTypeOf<RequestEntry<{ f: string }[]>>();
expectTypeOf(req.get('output').parse({})).toEqualTypeOf<ParseResult<{ title: string; scores: Record<string, number> }>>();
// @ts-expect-error — no schema of that name in this request.
req.get('nope');
// A named output is looked up by its name.
const named = ModelProfile.of(LENIENT).request([{ kind: 'output', name: 'answer', schema: Report }]);
expectTypeOf(named.get('answer')).toEqualTypeOf<RequestEntry<{ title: string; scores: Record<string, number> }>>();
// @ts-expect-error — a named output is not 'output'.
named.get('output');
// @ts-expect-error — a dynamic bundle must be bound before it goes in a request.
ModelProfile.of(LENIENT).request([{ kind: 'tool', name: 'rows', schema: Rows }]);

// ---------------------------------------------------------------------------
// Encoders and helpers
// ---------------------------------------------------------------------------

const enc = req.get('search').encoder;
expectTypeOf(enc).toEqualTypeOf<Encoder<{ query: string; limit?: number }>>();
expectTypeOf(enc({ query: 'q' })).toEqualTypeOf<string>();
// @ts-expect-error — the value must be the schema's code shape.
enc({ query: 1 });
expectTypeOf(req.get('search').encode).parameter(0).toEqualTypeOf<{ query: string; limit?: number }>();
expectTypeOf(req.helpers('search')).toEqualTypeOf<HelperSet>();
expectTypeOf(schemaHelpers(Search.render(LENIENT))).toEqualTypeOf<HelperSet>();
// @ts-expect-error — the default must name a schema of the request.
req.helpers('nope');

// ---------------------------------------------------------------------------
// Profiles from models
// ---------------------------------------------------------------------------

const model: ModelLike = { id: 'gpt-5', provider: 'openai', capabilities: new Set(['toolsStrict']) };
expectTypeOf(profileFor(model)).toEqualTypeOf<ModelProfile>();
expectTypeOf(profileFor(model).tool).toEqualTypeOf<Profile>();
// @aeye/ai's ModelInfo shape fits structurally (capabilities as a Set of a string union).
type Cap = 'chat' | 'tools' | 'toolsStrict' | 'structured';
const info: { id: string; provider: 'openai'; strictFormat?: 'openai' | 'none'; capabilities: Set<Cap>; name: string } =
  { id: 'gpt-5', provider: 'openai', capabilities: new Set<Cap>(['toolsStrict']), name: 'GPT-5' };
profileFor(info);
