/**
 * @aeye/core's strictify + toJSONSchema + decodeWire expectations
 * (packages/core/src/__tests__/schema.test.ts, wire-decode.test.ts,
 * schema-wire-records.test.ts), reproduced with @aeye/schema.
 *
 * Core rewrote a zod schema into each dialect (`strictify`), emitted JSON
 * (`toJSONSchema`) and decoded answers back (`decodeWire`). Here one `a`
 * schema is rendered per profile and the SAME rendering decodes, so every
 * expectation below is "render on the profile, assert the wire JSON,
 * decode the model-shaped answer, assert the code value and the copies".
 *
 * Deliberate differences from core are marked DELIBERATE; gaps are
 * `it.fails('GAP: ...')`.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT, GOOGLE_NON_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile,
  OPENAI_NON_STRICT, OPENAI_STRICT, XAI_STRICT, fromJSONSchema, schemaHelpers, type JsonSchema, type Profile,
} from '../../index';
import { asTool, clone, MODEL_PROFILES, profileProblems, validate } from './_check';
import * as S from './core-schema';

type J = Record<string, any>;
const props = (j: JsonSchema): J => j.properties as J;
const render = (s: { render(p: Profile): { jsonSchema: JsonSchema } }, p: Profile) => s.render(p).jsonSchema as J;
const compile = (t: string) => Handlebars.compile(t, { noEscape: true });
const NO_COPIES = { objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 };

describe('optional fields (core:schema.test.ts:33-157, :766-885)', () => {
  it('OpenAI strict: every field required, optionals nullable, objects closed (core:schema.test.ts:767)', () => {
    const js = render(S.NameAge, OPENAI_STRICT);
    expect(js.type).toBe('object');
    expect(js.required).toEqual(['name', 'age']);
    expect(js.additionalProperties).toBe(false);
    expect(props(js).name).toEqual({ type: 'string' });
    // DELIBERATE: core emitted exactly `{anyOf:[number,null]}`; `a` adds the instruction what null means.
    expect(props(js).age).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Write null to leave it out.' });
  });

  it('several optionals: all required, each `T | null` (core:schema.test.ts:782)', () => {
    const js = render(S.ManyOptional, OPENAI_STRICT);
    expect(js.required).toEqual(['required', 'optional1', 'optional2', 'optional3']);
    expect(props(js).optional1.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(props(js).optional2.anyOf).toEqual([{ type: 'number' }, { type: 'null' }]);
    expect(props(js).optional3.anyOf).toEqual([{ type: 'boolean' }, { type: 'null' }]);
  });

  it('nested objects, arrays of objects, optional arrays and complex nesting (core:schema.test.ts:810-885)', () => {
    const user = props(render(S.UserMetadata, OPENAI_STRICT)).user;
    expect(user.required).toEqual(['name', 'email']);
    expect(user.properties.email.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    const items = props(render(S.ItemValues, OPENAI_STRICT)).items;
    expect(items.type).toBe('array');
    expect(items.items.required).toEqual(['name', 'value']);
    expect(items.items.properties.value.anyOf).toEqual([{ type: 'number' }, { type: 'null' }]);
    const maybe = render(S.MaybeItems, OPENAI_STRICT);
    expect(maybe.required).toEqual(['items']);
    expect(props(maybe).items.anyOf.map((b: J) => b.type)).toEqual(['array', 'null']);
    const multi = render(S.MultiLevel, OPENAI_STRICT);
    expect(multi.required).toEqual(['required1', 'optional1', 'nested']);
    expect(props(multi).nested.required).toEqual(['required2', 'optional2', 'deepNested']);
    expect(props(multi).nested.properties.deepNested.required).toEqual(['required3', 'optional3']);
    const levels = render(S.Levels, OPENAI_STRICT);
    expect(levels.required).toEqual(['level1']);
    expect(props(levels).level1.anyOf.map((b: J) => b.type)).toEqual(['object', 'null']);
  });

  it('non-strict: optional left out of required, no null, objects open (core:schema.test.ts:887-921)', () => {
    for (const p of [LENIENT, OPENAI_NON_STRICT, ANTHROPIC_NON_STRICT, GOOGLE_NON_STRICT]) {
      const js = render(S.NameAge, p);
      expect(js.required).toEqual(['name']);
      expect(props(js).age).toEqual({ type: 'number' });
      expect(js.additionalProperties).toBeUndefined();
    }
  });

  it('decodes null → ABSENT in place, in every nesting (core:schema.test.ts:34-157, :194-229)', () => {
    const r = S.NameAge.render(OPENAI_STRICT);
    const wire = { name: 'John', age: null };
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ name: 'John' });
    expect(res.ok && 'age' in res.value).toBe(false); // absent, never `undefined`
    expect(res.ok && res.value).toBe(wire); // the same object, the key deleted in place
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 1 });
    expect(r.parse({ name: 'John', age: 25 }).ok && r.parse({ name: 'John', age: 25 })).toMatchObject({ value: { name: 'John', age: 25 }, stats: NO_COPIES });

    expect(S.ManyOptional.render(OPENAI_STRICT).parse({ required: 'test', optional1: null, optional2: null, optional3: true }))
      .toMatchObject({ ok: true, value: { required: 'test', optional3: true }, stats: { edits: 2 } });
    expect(S.UserMetadata.render(OPENAI_STRICT).parse({ user: { name: 'John', email: null }, metadata: null }))
      .toMatchObject({ ok: true, value: { user: { name: 'John' } } });
    expect(S.OuterInner.render(OPENAI_STRICT).parse({ outer: { inner: null } })).toMatchObject({ ok: true, value: { outer: {} } });
    const items = S.ItemValues.render(OPENAI_STRICT).parse({ items: [{ name: 'a', value: 1 }, { name: 'b', value: null }] });
    expect(items.ok && items.value).toEqual({ items: [{ name: 'a', value: 1 }, { name: 'b' }] });
    expect(S.MaybeItems.render(OPENAI_STRICT).parse({ items: null })).toMatchObject({ ok: true, value: {} });
    expect(S.MaybeData.render(OPENAI_STRICT).parse({ data: null })).toMatchObject({ ok: true, value: {} });
  });

  it('a required field left out is an error at its path (core:schema.test.ts:177)', () => {
    const res = S.RequiredOptional.render(OPENAI_STRICT).parse({ optional: null });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.issues).toEqual([{ path: ['required'], codePath: ['required'], message: 'Required.' }]);
    expect(!res.ok && res.message).toBe('- at required: Required.');
  });

  it('a record of optional values: a null value means the key is absent (core:schema.test.ts:231)', () => {
    const js = render(S.RecOfOptional, OPENAI_STRICT);
    expect(props(js).data.items.properties.value).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
    const res = S.RecOfOptional.render(OPENAI_STRICT).parse({ data: [{ key: 'a', value: 1 }, { key: 'b', value: null }] });
    // core: `{ a: 1, b: undefined }`; `a` has no present-but-undefined, the key is left out.
    expect(res.ok && res.value).toEqual({ data: { a: 1 } });
    expect(res.stats).toMatchObject({ objects: 1 });
  });

  it('unions and discriminated unions with optional fields (core:schema.test.ts:266-318)', () => {
    expect(S.UnionOpt.render(OPENAI_STRICT).parse({ value: { type: 'a', data: null } })).toMatchObject({ ok: true, value: { value: { type: 'a' } } });
    expect(S.UnionOpt.render(OPENAI_STRICT).parse({ value: { type: 'b', count: null } })).toMatchObject({ ok: true, value: { value: { type: 'b' } } });
    expect(S.ItemDU.render(OPENAI_STRICT).parse({ item: { type: 'text', content: null } })).toMatchObject({ ok: true, value: { item: { type: 'text' } } });
    expect(S.ItemDU.render(OPENAI_STRICT).parse({ item: { type: 'number', value: null } })).toMatchObject({ ok: true, value: { item: { type: 'number' } } });
    // MINIMAL has no combinators: the union is one nullable field per option (tagged).
    const tagged = render(S.ItemDU, MINIMAL);
    expect(Object.keys(props(tagged).item.properties)).toEqual(['text', 'number']);
    const res = S.ItemDU.render(MINIMAL).parse({ item: { text: { type: 'text', content: 'hi' }, number: null } });
    expect(res.ok && res.value).toEqual({ item: { type: 'text', content: 'hi' } });
  });

  it('intersections with optional fields (core:schema.test.ts:493): merged, null → absent', () => {
    const js = render(S.InterOpt, OPENAI_STRICT);
    expect(props(js).data.required).toEqual(['a', 'b']);
    expect(props(js).data.allOf).toBeUndefined();
    const res = S.InterOpt.render(OPENAI_STRICT).parse({ data: { a: 'test', b: null } });
    expect(res.ok && res.value).toEqual({ data: { a: 'test' } });
  });

  it('defaults: left out or null decodes to the default (core:schema.test.ts:529, :937)', () => {
    const r = S.WithDefault.render(OPENAI_STRICT);
    expect(r.parse({ value: null })).toMatchObject({ ok: true, value: { value: 'default' } });
    expect(r.parse({ value: 'custom' })).toMatchObject({ ok: true, value: { value: 'custom' } });
    expect(S.WithDefault.render(LENIENT).parse({})).toMatchObject({ ok: true, value: { value: 'default' } });
    // DELIBERATE: core emitted the `default` keyword; `a` says it in words (strict dialects reject `default`).
    expect(props(render(S.RoleDefault, LENIENT)).role).toEqual({ type: 'string', description: 'Default when left out: "user".' });
  });

  it('lazy/recursive schemas with optional fields (core:schema.test.ts:554)', () => {
    const res = S.RootNode.render(OPENAI_STRICT).parse({ root: { value: 'root', children: [{ value: 'child1', children: null }, { value: 'child2', children: null }] } });
    expect(res.ok && res.value).toEqual({ root: { value: 'root', children: [{ value: 'child1' }, { value: 'child2' }] } });
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 2 });
  });

  it('codecs and pipes keep their transforms (core:schema.test.ts:589, :616)', () => {
    expect(render(S.CodecData, OPENAI_STRICT).properties.data).toEqual({ type: 'object', properties: { raw: { type: 'string' } }, required: ['raw'], additionalProperties: false });
    expect(S.CodecData.render(OPENAI_STRICT).parse({ data: { raw: 'test' } })).toMatchObject({ ok: true, value: { data: { value: 'test' } } });
    expect(S.CodecData.render(OPENAI_STRICT).encode({ data: {} })).toEqual({ data: { raw: 'empty' } });
    expect(S.Upper.render(OPENAI_STRICT).parse({ value: 'test' })).toMatchObject({ ok: true, value: { value: 'TEST' } });
    expect(S.Upper.render(OPENAI_STRICT).parse({ value: null })).toMatchObject({ ok: true, value: {} });
  });

  it('primitives pass through untouched (core:schema.test.ts:639-680)', () => {
    for (const [s, v] of [[S.StringValue, 'test'], [S.NumberValue, 42], [S.BooleanValue, true]] as const) {
      const wire = { value: v };
      const res = (s as typeof S.StringValue).render(OPENAI_STRICT).parse(wire);
      expect(res.ok && res.value).toBe(wire);
      expect(res.stats).toEqual(NO_COPIES);
    }
  });

  it('descriptions survive (core:schema.test.ts:683, :924)', () => {
    expect(props(render(S.DescribedOptional, LENIENT)).value.description).toBe('A test value');
    const js = render(S.Described, OPENAI_STRICT);
    expect(props(js).name.description).toBe('User name');
    // DELIBERATE: the null instruction is appended to the field's own description.
    expect(props(js).age.description).toBe('User age\nWrite null to leave it out.');
  });

  it('enums, optional unions, records, empty objects (core:schema.test.ts:951-988, :1106)', () => {
    const e = render(S.StatusPriority, OPENAI_STRICT);
    expect(props(e).status.enum).toEqual(['active', 'inactive']);
    expect(e.required).toContain('priority');
    const u = render(S.MaybeStrNum, OPENAI_STRICT);
    expect(u.required).toContain('value');
    expect(props(u).value.anyOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'null' }]);
    expect(props(render(S.DataRecord, OPENAI_STRICT)).data.type).toBe('array');
    expect(render(S.Empty, OPENAI_STRICT)).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  });
});

describe('nullable vs optional (core:schema.test.ts:320-491, :989-1103, :1821-1835)', () => {
  it('nullable keeps null and is required', () => {
    const js = render(S.NullableValue, OPENAI_STRICT);
    expect(js.required).toContain('value');
    expect(props(js).value).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] }); // no "leave it out" text
    const r = S.NullableValue.render(OPENAI_STRICT);
    expect(r.parse({ value: null })).toMatchObject({ ok: true, value: { value: null }, stats: NO_COPIES });
    expect(r.parse({ value: 'test' })).toMatchObject({ ok: true, value: { value: 'test' } });
    const missing = r.parse({});
    expect(!missing.ok && missing.issues[0]?.path).toEqual(['value']);
  });

  it('nullable().optional() and optional().nullable(): null stays null (core:schema.test.ts:362, :398)', () => {
    for (const s of [S.NullableOptional, S.OptionalNullable]) {
      const r = s.render(OPENAI_STRICT);
      expect(r.parse({ name: 'test', value: null })).toMatchObject({ ok: true, value: { name: 'test', value: null } });
      expect(r.parse({ name: 'test', value: 'actual' })).toMatchObject({ ok: true, value: { value: 'actual' } });
      // Non-strict: omission is absence.
      const lenient = s.render(LENIENT).parse({ name: 'test' });
      expect(lenient.ok && 'value' in lenient.value).toBe(false);
    }
    // The "mixed" case: all four kinds required on OpenAI strict, each spelled with anyOf.
    const js = render(S.Mixed, OPENAI_STRICT);
    expect(js.required).toEqual(['required', 'nullable', 'optional', 'nullableOptional']);
    expect(props(js).required).toEqual({ type: 'string' });
    expect(props(js).optional.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(props(js).nullableOptional.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('nested nullable and nullable arrays (core:schema.test.ts:434-491, :1065-1103)', () => {
    const js = render(S.UserBio, OPENAI_STRICT);
    expect(js.required).toEqual(['user']);
    expect(props(js).user.required).toEqual(['name', 'email', 'bio']);
    expect(S.UserBio.render(OPENAI_STRICT).parse({ user: { name: 'John', email: null, bio: null } }))
      .toMatchObject({ ok: true, value: { user: { name: 'John', email: null, bio: null } } });
    expect(S.NullableElements.render(OPENAI_STRICT).parse({ items: ['a', null, 'b', null] })).toMatchObject({ ok: true, value: { items: ['a', null, 'b', null] } });
    const list = S.NullableList.render(OPENAI_STRICT);
    expect(list.parse({ items: null })).toMatchObject({ ok: true, value: { items: null } });
    expect(list.parse({ items: ['a', null, 'b'] })).toMatchObject({ ok: true, value: { items: ['a', null, 'b'] } });
    const arr = render(S.NullableArray, OPENAI_STRICT);
    expect(arr.required).toContain('items');
    expect(props(arr).items.anyOf.map((b: J) => b.type)).toEqual(['array', 'null']);
  });

  it('per dialect: null is admitted for nullable, optional goes to required[] (core:schema.test.ts:1821-1835)', () => {
    // core: `anyOf:[string,null]` under ANTHROPIC_STRICT and LENIENT too.
    // DELIBERATE: `a` spells null per profile — anyOf only where a type array is rejected (OpenAI strict, o3);
    // a type array elsewhere, `nullable: true` on Gemini's OpenAPI subset. Every spelling admits null.
    expect(props(render(S.NoteTag, OPENAI_STRICT))).toEqual({
      note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      tag: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Write null to leave it out.' },
    });
    for (const p of [ANTHROPIC_STRICT, LENIENT, XAI_STRICT, GOOGLE_STRICT]) {
      const js = render(S.NoteTag, p);
      expect(props(js)).toEqual({ note: { type: ['string', 'null'] }, tag: { type: 'string' } });
      expect(js.required).toEqual(['note']);
      expect(validate(js, { note: null })).toEqual([]);
    }
    expect(props(render(S.NoteTag, GOOGLE_OPENAPI)).note).toEqual({ type: 'string', nullable: true });
  });
});

describe('open objects / catchall (core:schema.test.ts:705-763)', () => {
  it('rest(unknown) keeps unknown keys in place', () => {
    const wire = { name: 'x', extra: 1, nested: { a: true } };
    const res = S.OpenAny.render(LENIENT).parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual(NO_COPIES);
  });

  it('a typed rest validates through it', () => {
    expect(S.OpenNum.render(LENIENT).parse({ name: 'x', count: 2 })).toMatchObject({ ok: true, value: { name: 'x', count: 2 } });
    const bad = S.OpenNum.render(LENIENT).parse({ name: 'x', count: 'nope' });
    expect(!bad.ok && bad.message).toBe('- at count: Expected a number, got string.');
  });

  it('strict() rejects unknown keys', () => {
    const res = S.ClosedName.render(LENIENT).parse({ name: 'x', extra: 1 });
    expect(!res.ok && res.issues).toEqual([{ path: ['extra'], codePath: ['extra'], message: 'Unknown field "extra".' }]);
  });

  it('DELIBERATE: a plain object leaves unknown keys in place (core stripped them; `a` copies nothing to strip)', () => {
    const wire = { name: 'x', extra: 1 };
    const res = S.PlainName.render(LENIENT).parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.ok && res.value).toEqual({ name: 'x', extra: 1 });
  });

  it('the rest VALUE is rewritten too: OpenAI strict sends extra keys as pairs, records inside them as pairs', () => {
    const js = render(S.OpenTagged, OPENAI_STRICT);
    expect(js.required).toEqual(['name', 'extra']);
    expect(js.description).toBe('Other keys go in "extra" as a list of {key, value} entries.');
    expect(props(js).extra.items.properties.value.properties.tags.type).toBe('array');
    const res = S.OpenTagged.render(OPENAI_STRICT).parse({ name: 'x', extra: [{ key: 'anything', value: { tags: [{ key: 'a', value: 'b' }] } }] });
    expect(res.ok && res.value).toEqual({ name: 'x', anything: { tags: { a: 'b' } } });
    expect(res.stats).toEqual({ ...NO_COPIES, objects: 1, edits: 3 });
    // Encoding writes the same shape the model reads.
    // @ts-expect-error GAP (types): `.rest(V)` types the object as `{ name: string } & { [key: string]: V }`, which no
    // literal satisfies when a declared field is not a V (zod's catchall has the same hole; the value is valid).
    expect(S.OpenTagged.render(OPENAI_STRICT).encode({ name: 'x', anything: { tags: { a: 'b' } } }))
      .toEqual({ name: 'x', extra: [{ key: 'anything', value: { tags: [{ key: 'a', value: 'b' } ] } }] });
  });

  it('a declared field named "extra" keeps its schema; the rest pairs move to "_extra"', () => {
    const Collide = S.OpenNum.extend({ extra: S.PlainName });
    const js = Collide.render(OPENAI_STRICT).jsonSchema as J;
    expect(props(js).extra.type).toBe('object');
    expect(js.required).toEqual(['name', 'extra', '_extra']);
    expect(js.description).toBe('Other keys go in "_extra" as a list of {key, value} entries.');
    const res = Collide.render(OPENAI_STRICT).parse({ name: 'x', extra: { name: 'y' }, _extra: [{ key: 'count', value: 2 }] });
    expect(res.ok && res.value).toEqual({ name: 'x', extra: { name: 'y' }, count: 2 });
  });
});

describe('the cletus type-helper schemas (core:schema.test.ts:1239-1800)', () => {
  it('recursive where clauses: $defs + $ref, optional refs nullable (core:schema.test.ts:1241, :1306, :1359)', () => {
    for (const s of [S.TestTypeWhere, S.WhereFixed]) {
      const js = render(s, OPENAI_STRICT);
      expect(Object.keys(props(js))).toEqual(expect.arrayContaining(['and', 'or', 'not']));
      expect(js.$defs).toBeDefined();
      // DELIBERATE: core put `and`'s anyOf in a $defs entry; `a` inlines the nullable array around the item ref.
      expect(props(js).and.anyOf.map((b: J) => b.type)).toEqual(['array', 'null']);
      expect(props(js).and.anyOf[0].items.$ref).toMatch(/^#\/\$defs\/TestType_where/);
      expect(props(js).not.anyOf[0].$ref).toMatch(/^#\/\$defs\/TestType_where/);
    }
  });

  it('parses nested where clauses written the OpenAI-strict way (core:schema.test.ts:1430, :1479, :1766)', () => {
    const N = { and: null, or: null, not: null, name: null, age: null };
    const res = S.WhereLte.render(OPENAI_STRICT).parse({
      ...N,
      and: [
        { ...N, name: { equals: null, contains: 'John' } },
        { ...N, or: [{ ...N, age: { equals: null, gte: 18, lte: null } }, { ...N, age: { equals: null, gte: null, lte: 65 } }] },
      ],
    });
    expect(res.ok && res.value).toEqual({ and: [{ name: { contains: 'John' } }, { or: [{ age: { gte: 18 } }, { age: { lte: 65 } }] }] });
    expect(res.stats.objects + res.stats.arrays).toBe(0); // nulls deleted in place, nothing copied

    const T = { and: null, or: null, not: null, status: null, priority: null };
    const deep = S.TaskWhere.render(OPENAI_STRICT).parse({
      ...T,
      and: [
        { ...T, status: { equals: 'active' } },
        { ...T, or: [{ ...T, priority: { equals: 1 } }, { ...T, and: [{ ...T, priority: { equals: 2 } }, { ...T, not: { ...T, status: { equals: 'archived' } } }] }] },
      ],
    });
    expect(deep.ok && deep.value).toEqual({
      and: [{ status: { equals: 'active' } }, { or: [{ priority: { equals: 1 } }, { and: [{ priority: { equals: 2 } }, { not: { status: { equals: 'archived' } } }] }] }],
    });

    const logical = S.WhereStatus.render(LENIENT).parse({ not: { or: [{ status: { equals: 'deleted' } }, { status: { equals: 'archived' } }] } });
    expect(logical.ok && logical.value.not?.or?.length).toBe(2);
  });

  it('empty where clauses (core:schema.test.ts:1737)', () => {
    const r = S.WhereAndOr.render(LENIENT);
    expect(r.parse({})).toMatchObject({ ok: true, value: {} });
    expect(r.parse({ name: { equals: 'test' } })).toMatchObject({ ok: true, value: { name: { equals: 'test' } } });
    expect(r.parse({ and: [], or: [] })).toMatchObject({ ok: true, value: { and: [], or: [] } });
  });

  it('Anthropic strict (no recursion): the recursive parts are JSON text and still decode', () => {
    const r = S.TaskWhere.render(ANTHROPIC_STRICT);
    const and = props(r.jsonSchema).and;
    expect(and.items.type).toBe('string');
    expect(and.items.description).toMatch(/^"Task_where" contains itself/);
    expect(r.jsonSchema.description).toContain('type Task_where = {');
    const res = r.parse({ and: ['{"status":{"equals":"active"}}', '{"not":{"priority":{"equals":3}}}'] });
    expect(res.ok && res.value).toEqual({ and: [{ status: { equals: 'active' } }, { not: { priority: { equals: 3 } } }] });
    expect(res.stats).toMatchObject({ parsed: 2 });
    // A wrong value INSIDE the JSON text: the path goes through it.
    const bad = r.parse({ and: ['{"priority":{"equals":"high"}}'] });
    expect(!bad.ok && bad.issues[0]?.path).toEqual(['and', 0, '(json)', 'priority', 'equals']);
    expect(!bad.ok && bad.issues[0]?.codePath).toEqual(['and', 0, 'priority', 'equals']);
  });

  it('an optional root object (enum conditions, core:schema.test.ts:1599): wrapped as {input}, null → absent', () => {
    const js = render(S.EnumCondition, asTool(OPENAI_STRICT));
    expect(js.required).toEqual(['input']);
    expect(props(js).input.anyOf.map((b: J) => b.type)).toEqual(['object', 'null']);
    expect(props(js).input.anyOf[0].properties.equals.anyOf[0].enum).toEqual(['option1', 'option2', 'option3']);
    const r = S.EnumCondition.render(asTool(OPENAI_STRICT));
    expect(r.parse({ input: null })).toMatchObject({ ok: true });
    expect(r.parse({ input: { equals: 'option2', oneOf: null, isEmpty: null } })).toMatchObject({ ok: true, value: { equals: 'option2' } });
  });

  it('field sets: an array of field/value unions (core:schema.test.ts:1620, :1650)', () => {
    const js = render(S.FieldSet, asTool(OPENAI_STRICT));
    expect(props(js).input.type).toBe('array');
    expect(props(js).input.title).toBe('TestType_fieldset');
    expect(props(js).input.items.anyOf).toHaveLength(3);
    const wire = { input: [{ field: 'name', value: 'John Doe' }, { field: 'age', value: 30 }, { field: 'age', value: null }] };
    const res = S.FieldSetNullable.render(asTool(OPENAI_STRICT)).parse(wire);
    expect(res.ok && res.value).toBe(wire.input); // unwrapped, nothing copied
    expect(res.stats).toEqual(NO_COPIES);
    const wrong = S.FieldSet.render(asTool(OPENAI_STRICT)).parse({ input: [{ field: 'age', value: 'thirty' }] });
    // Auto-discriminated by the `field` literal: the error lands inside the chosen option.
    expect(!wrong.ok && wrong.issues[0]?.path).toEqual(['input', 0, 'value']);
    expect(!wrong.ok && wrong.issues[0]?.codePath).toEqual([0, 'value']);
  });

  it('a type\'s fields: every field required, nullable ones admit null (core:schema.test.ts:1684, :1726)', () => {
    const js = render(S.UserFields, OPENAI_STRICT);
    expect(js.required).toEqual(['email', 'age', 'isAdmin', 'role', 'createdAt']);
    for (const k of ['age', 'isAdmin', 'role']) expect(props(js)[k].anyOf.map((b: J) => b.type)).toContain('null');
    expect(props(js).email).toEqual({ type: 'string' });
    expect(props(js).createdAt).toEqual({ type: 'string', format: 'date' });
    expect(js.title).toBe('User_fields');
    expect(props(render(S.UserFieldNames, asTool(OPENAI_STRICT))).input.enum).toEqual(['name', 'email', 'age', 'active']);
    const bad = S.UserFields.render(OPENAI_STRICT).parse({ email: 'a@b.c', age: null, isAdmin: null, role: 'owner', createdAt: '2026-11-24' });
    expect(!bad.ok && bad.issues[0]).toMatchObject({ path: ['role'], codePath: ['role'] });
  });

  it('a registered id names the definition, under every dialect (core:schema.test.ts:1801)', () => {
    expect(Object.keys(render(S.RegisteredRoot, OPENAI_STRICT).$defs)).toEqual(['StrictifyRegisteredNode']);
    expect(() => render(S.RegisteredRoot, ANTHROPIC_STRICT)).not.toThrow();
  });
});

describe('end to end (core:schema.test.ts:1162-1237)', () => {
  it('define → render → parse with nulls → absent', () => {
    const js = render(S.Workflow, OPENAI_STRICT);
    expect(js.required).toEqual(['id', 'name', 'email', 'age', 'settings']);
    expect(props(js).settings.required).toEqual(['theme', 'notifications']);
    const res = S.Workflow.render(OPENAI_STRICT).parse({ id: '123', name: 'John', email: null, age: null, settings: { theme: 'dark', notifications: null } });
    expect(res.ok && res.value).toEqual({ id: '123', name: 'John', settings: { theme: 'dark' } });
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 3 });
    const users = S.Users.render(OPENAI_STRICT).parse({ users: [{ name: 'Alice', email: 'alice@example.com' }, { name: 'Bob', email: null }] });
    expect(users.ok && users.value).toEqual({ users: [{ name: 'Alice', email: 'alice@example.com' }, { name: 'Bob' }] });
  });

  it('every profile family: renders in-dialect, round-trips the samples, decodes code values without copies', () => {
    expect(profileProblems(S.Workflow, [
      { id: '123', name: 'John', settings: { theme: 'dark' } },
      { id: '1', name: 'Ann', email: 'a@b.c', age: 40, settings: { theme: 'light', notifications: true } },
    ])).toEqual([]);
    // An absent optional-NULLABLE can't round-trip under null-for-absent (documented: null stays null), so the samples give it a value.
    expect(profileProblems(S.Mixed, [{ required: 'r', nullable: null, nullableOptional: null }, { required: 'r', nullable: 'n', optional: 'o', nullableOptional: 'x' }], { profiles: [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, GOOGLE_OPENAPI, XAI_STRICT] })).toEqual([]);
    expect(profileProblems(S.UserMetadata, [{ user: { name: 'J' } }, { user: { name: 'J', email: 'e' }, metadata: { tags: ['x'] } }])).toEqual([]);
    expect(profileProblems(S.UnionOpt, [{ value: { type: 'a' } }, { value: { type: 'b', count: 2 } }])).toEqual([]);
    expect(profileProblems(S.ItemDU, [{ item: { type: 'text', content: 'c' } }, { item: { type: 'number' } }])).toEqual([]);
    expect(profileProblems(S.InterOpt, [{ data: { a: 'x' } }, { data: { a: 'x', b: 2 } }])).toEqual([]);
    // (MINIMAL was left out for the optional-nullable gap, now fixed: every profile.)
    expect(profileProblems(S.UserBio, [{ user: { name: 'n', email: null, bio: null } }, { user: { name: 'n', email: 'e', bio: 'b' } }])).toEqual([]);
    expect(profileProblems(S.NullableList, [{ items: null }, { items: ['a', null] }])).toEqual([]);
    // xAI takes an object with properties AND a schema-valued additionalProperties (open records were
    // accepted live); _check's "closed objects" rule flags it, so xAI is checked by hand here.
    expect(profileProblems(S.OpenTagged, [{ name: 'x' }, { name: 'x', anything: { tags: { a: 'b' } } }], { profiles: MODEL_PROFILES.filter((p) => p.family !== 'xai') })).toEqual([]);
    const grok = S.OpenTagged.render(asTool(XAI_STRICT));
    expect(grok.jsonSchema.additionalProperties).toEqual({ type: 'object', properties: { tags: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['tags'], additionalProperties: false });
    expect(grok.parse({ name: 'x', anything: { tags: { a: 'b' } } })).toMatchObject({ ok: true, stats: NO_COPIES });
    expect(profileProblems(S.TestTypeWhere, [{}, { and: [{ name: { contains: 'J' } }, { or: [{ age: { gte: 18 } }] }], not: { active: { equals: false } } }])).toEqual([]);
    expect(profileProblems(S.TaskWhere, [{ and: [{ status: { equals: 'a' } }, { not: { priority: { equals: 1 } } }] }])).toEqual([]);
    expect(profileProblems(S.FieldSet, [[{ field: 'name', value: 'n' }, { field: 'age', value: 1 }, { field: 'active', value: true }]])).toEqual([]);
    expect(profileProblems(S.UserFields, [{ email: 'e', age: null, isAdmin: true, role: 'admin', createdAt: '2026-01-01' }])).toEqual([]);
    expect(profileProblems(S.RegisteredRoot, [{ root: { name: 'r', children: [{ name: 'c' }] } }])).toEqual([]);
    expect(profileProblems(S.EnumCondition, [{ equals: 'option1', oneOf: ['option2'] }, { isEmpty: true }])).toEqual([]);
    expect(profileProblems(S.CodecData, [{ data: { value: 'v' } }], { codecs: true })).toEqual([]);
    expect(profileProblems(S.WithDefault, [{ value: 'custom' }])).toEqual([]);
  });

  it('the {{encode}} helper shows a where clause in each model\'s shape', () => {
    const t = compile('Filter like: {{encode example}}');
    const example = { status: { equals: 'open' } };
    const gpt = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'find', schema: S.WhereStatus }]).get('find');
    expect(t({ example }, { helpers: gpt.helpers() })).toBe('Filter like: {"and":null,"or":null,"not":null,"status":{"equals":"open"}}');
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'find', schema: S.WhereStatus }]).get('find');
    expect(t({ example: { not: example } }, { helpers: claude.helpers() })).toBe('Filter like: {"not":"{\\"status\\":{\\"equals\\":\\"open\\"}}"}');
    expect(t({ example }, { helpers: schemaHelpers(S.WhereStatus.render(LENIENT)) })).toBe('Filter like: {"status":{"equals":"open"}}');
  });
});

describe('optional + nullable on a dialect with no combinators', () => {
  it('(was GAP) optional-nullable on MINIMAL is spelled anyOf (a combinator the dialect lacks) around a type array', () => {
    // core:schema.test.ts:1036 nullableOptional; MINIMAL has `unions: 'tagged'` and `nulls: 'type-array'`.
    const js = render(S.Mixed, MINIMAL);
    expect(props(js).nullableOptional).toEqual({ type: ['string', 'null'], description: 'Write null to leave it out.' });
  });
});

describe('encoding an absent optional-nullable field', () => {
  it.fails('GAP: under null-for-absent the key is required, but encode leaves it out when no plain optional sits beside it', () => {
    // core:schema.test.ts:363 — z.string().nullable().optional(); OpenAI strict lists it in required[].
    const r = S.NullableOptional.render(OPENAI_STRICT);
    const wire = r.encode({ name: 'r' });
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    expect(wire).toEqual({ name: 'r', value: null });
  });
});

describe('optional tuple positions (core:schema.test.ts:512)', () => {
  it.fails('GAP: optional tuple element — `[string, number?]` accepts a missing last item and decodes a strict null to absent', () => {
    // zod: z.tuple([z.string(), z.number().optional()]) accepts ['test'] and ['test', 1];
    // OpenAI strict sends {"0":"test","1":null} and core decoded tuple[1] to undefined.
    expect(S.TupleOpt.render(LENIENT).parse({ tuple: ['test'] }).ok).toBe(true);
    const res = S.TupleOpt.render(OPENAI_STRICT).parse({ tuple: { 0: 'test', 1: null } });
    expect(res.ok && res.value.tuple).toEqual(['test']);
  });
});

// ============================================================================
// wire-decode.test.ts
// ============================================================================

describe('decodeWire specifics (core:wire-decode.test.ts:313-372)', () => {
  it('DELIBERATE: garbage is an issue at the root, not passed through (core decodeWire never failed)', () => {
    const r = S.RecA.render(OPENAI_STRICT);
    for (const [wire, got] of [[12345, 'number'], [null, 'null'], ['a string', 'string']] as const) {
      const res = r.parse(wire);
      expect(!res.ok && res.message).toBe(`- at (root): Expected an object, got ${got}.`);
    }
  });

  it('DELIBERATE: a valid record next to a bad sibling: the record decodes, the sibling is reported (core passed it through)', () => {
    const wire = { rec: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }], n: 'NOT A NUMBER' };
    const res = S.RecN.render(OPENAI_STRICT).parse(wire);
    expect(!res.ok && res.issues).toEqual([{ path: ['n'], codePath: ['n'], message: 'Expected a number, got string.' }]);
  });

  it('null-for-optional → absent (core:wire-decode.test.ts:340)', () => {
    const res = S.NameNote.render(OPENAI_STRICT).parse({ name: 'x', note: null });
    expect(res.ok && res.value).toEqual({ name: 'x' });
    expect(res.ok && 'note' in res.value).toBe(false);
  });

  it('DELIBERATE: duplicate pair keys are an error the model can fix (core: last duplicate wins)', () => {
    const res = S.RecM.render(OPENAI_STRICT).parse({ m: [{ key: 'a', value: 1 }, { key: 'a', value: 9 }, { key: 'b', value: 2 }] });
    expect(!res.ok && res.issues).toEqual([{ path: ['m', 1, 'key'], codePath: ['m'], message: 'Duplicate key "a".' }]);
  });

  it('DELIBERATE: a pair missing its key is an error (core skipped the entry silently)', () => {
    const res = S.RecM.render(OPENAI_STRICT).parse({ m: [{ key: 'a', value: 1 }, { novalue: true }, { key: 'b', value: 2 }] });
    expect(!res.ok && res.message).toBe('- at m[1].key: Expected a string, got undefined.');
  });

  it('numeric-key object → tuple; records inside arrays (core:wire-decode.test.ts:359, :365)', () => {
    const p = S.Point.render(OPENAI_STRICT).parse({ point: { 0: 1, 1: 2, 2: 'z' } });
    expect(p.ok && p.value).toEqual({ point: [1, 2, 'z'] });
    expect(p.stats).toEqual({ ...NO_COPIES, arrays: 1, edits: 1 });
    const rows = S.Rows.render(OPENAI_STRICT).parse({ rows: [[{ key: 'a', value: 1 }], [{ key: 'b', value: 2 }]] });
    expect(rows.ok && rows.value).toEqual({ rows: [{ a: 1 }, { b: 2 }] });
    expect(rows.stats).toMatchObject({ objects: 2 });
  });

  it('a record sent as a JSON string is repaired (counted)', () => {
    const res = S.ArgsLimit.render(OPENAI_STRICT).parse({ args: '[{"key":"a","value":"b"}]', limit: null });
    expect(res.ok && res.value).toEqual({ args: { a: 'b' } });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 0, repaired: 1 });
    const off = S.ArgsLimit.render(OPENAI_STRICT).parse({ args: '[{"key":"a","value":"b"}]', limit: null }, { repair: false });
    expect(off.ok).toBe(false);
  });
});

describe('symmetry: one code value, each profile\'s wire (core:wire-decode.test.ts:374-424)', () => {
  const conceptual: S.Symmetry = { id: 'x', scores: { a: 1, b: 2 }, coord: [10, 20], note: 'hi' };
  /** The wire a model sends under `p`, built from the profile's own rules (as core's buildWire). */
  const buildWire = (p: Profile): Record<string, unknown> => {
    const wire: Record<string, unknown> = {
      id: 'x',
      scores: p.records === 'pairs' ? [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] : { a: 1, b: 2 },
      coord: p.tuples === 'object' ? { 0: 10, 1: 20 } : [10, 20],
      note: 'hi',
    };
    if (p.optional === 'null') wire.extra = null;
    return wire;
  };
  const profiles: Profile[] = [LENIENT, OPENAI_STRICT, OPENAI_NON_STRICT, ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT, GOOGLE_STRICT, GOOGLE_NON_STRICT, GOOGLE_OPENAPI, XAI_STRICT, MINIMAL];
  for (const p of profiles) {
    it(`${p.id}: wire → code round-trips, the wire is what the JSON sent allows, and encode writes it back`, () => {
      const r = S.Symmetry.render(p);
      const wire = buildWire(p);
      expect(validate(r.jsonSchema, wire)).toEqual([]);
      expect(r.encode(conceptual)).toEqual(buildWire(p));
      const res = r.parse(clone(wire));
      expect(res.ok && res.value).toEqual(conceptual);
    });
  }

  it('copies per profile: pairs → one object, numeric keys → one array, null → one edit', () => {
    expect(S.Symmetry.render(OPENAI_STRICT).parse(buildWire(OPENAI_STRICT)).stats).toEqual({ objects: 1, arrays: 1, edits: 3, parsed: 0, repaired: 0 });
    expect(S.Symmetry.render(ANTHROPIC_STRICT).parse(buildWire(ANTHROPIC_STRICT)).stats).toEqual({ objects: 1, arrays: 0, edits: 1, parsed: 0, repaired: 0 });
    const g = buildWire(GOOGLE_STRICT);
    const res = S.Symmetry.render(GOOGLE_STRICT).parse(g);
    expect(res.ok && res.value).toBe(g); // open records, prefixItems: the wire IS the code shape
    expect(res.stats).toEqual(NO_COPIES);
  });

  it('the OpenAI-strict wire differs from Gemini\'s', () => {
    expect(buildWire(OPENAI_STRICT)).not.toEqual(buildWire(GOOGLE_STRICT));
  });

  it('wrong answers: issues at the wire path AND the code path', () => {
    const res = S.Symmetry.render(OPENAI_STRICT).parse({ id: 'x', scores: [{ key: 'a', value: '1' }], coord: { 0: 1, 1: 2 }, note: null, extra: null });
    expect(!res.ok && res.issues).toEqual([{ path: ['scores', 0, 'value'], codePath: ['scores', 'a'], message: 'Expected a number, got string.' }]);
    const t = S.Symmetry.render(ANTHROPIC_STRICT).parse({ id: 'x', scores: [{ key: 'a', value: 1 }], coord: [10, 'x'] });
    expect(!t.ok && t.message).toBe('- at coord[1]: Expected a number, got string.');
  });

  it('an example in the code shape is shown in the shape of each model', () => {
    const X = S.Symmetry.example({ id: 'x', scores: { a: 1 }, coord: [10, 20] });
    expect(X.render(OPENAI_STRICT).jsonSchema.description).toBe('Example: {"id":"x","scores":[{"key":"a","value":1}],"coord":{"0":10,"1":20},"note":null,"extra":null}');
    expect(X.render(ANTHROPIC_STRICT).jsonSchema.description).toBe('Example: {"id":"x","scores":[{"key":"a","value":1}],"coord":[10,20]}');
    expect(X.render(GOOGLE_STRICT).jsonSchema.description).toBe('Example: {"id":"x","scores":{"a":1},"coord":[10,20]}');
    expect(X.render(LENIENT).jsonSchema.examples).toEqual([{ id: 'x', scores: { a: 1 }, coord: [10, 20] }]);
  });

  it('every profile family', () => {
    expect(profileProblems(S.Symmetry, [conceptual, { id: 'y', scores: {}, coord: [0, 0] }])).toEqual([]);
  });
});

describe('symmetry with unions and recursion (core:wire-decode.test.ts:425-481)', () => {
  it('OpenAI strict: a union of objects each carrying a record', () => {
    const r = S.KindMaps.render(asTool(OPENAI_STRICT));
    expect(r.parse({ input: { kind: 'a', amap: [{ key: 'k', value: 9 }] } })).toMatchObject({ ok: true, value: { kind: 'a', amap: { k: 9 } } });
    expect(r.parse({ input: { kind: 'b', bmap: [{ key: 'k', value: 'v' }] } })).toMatchObject({ ok: true, value: { kind: 'b', bmap: { k: 'v' } } });
    expect(profileProblems(S.KindMaps, [{ kind: 'a', amap: { k: 1 } }, { kind: 'b', bmap: {} }])).toEqual([]);
  });

  it('Anthropic strict: records → pairs, tuples stay arrays, optional omitted', () => {
    const res = S.MixedAnthropic.render(ANTHROPIC_STRICT).parse({ m: [{ key: 'a', value: 1 }], t: ['x', 2] });
    expect(res.ok && res.value).toEqual({ m: { a: 1 }, t: ['x', 2] });
    expect(profileProblems(S.MixedAnthropic, [{ m: { a: 1 }, t: ['x', 2] }, { m: {}, t: ['', 0], opt: 3 }])).toEqual([]);
  });

  it('a recursive node with a record inside round-trips (OpenAI strict)', () => {
    const res = S.MetaNode.render(OPENAI_STRICT).parse({
      name: 'root', meta: [{ key: 'a', value: 'b' }],
      children: [{ name: 'child', meta: [{ key: 'x', value: 'y' }], children: null }],
    });
    expect(res.ok && res.value).toEqual({ name: 'root', meta: { a: 'b' }, children: [{ name: 'child', meta: { x: 'y' } }] });
    expect(res.stats).toEqual({ ...NO_COPIES, objects: 2, edits: 3 });
    expect(profileProblems(S.MetaNode, [{ name: 'r', meta: { a: 'b' }, children: [{ name: 'c', meta: {} }] }])).toEqual([]);
  });
});

describe('what a custom parse hook receives (core:wire-decode.test.ts:483-574)', () => {
  // Core's Tool/Prompt with a custom `parse` got decodeWire's output. With `a`, the hook IS the schema
  // (a codec/refine) and parse always goes through the entry the request rendered — there is no
  // "no descriptor" path that hands the hook the raw pairs.
  it('the tool\'s entry decodes pairs + null-optional to the code shape', () => {
    const tool = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'wire-tool', schema: S.ArgsLimit }]).get('wire-tool');
    expect(tool.parseText(JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }))).toMatchObject({ ok: true, value: { args: { a: 'b' } } });
    expect(tool.parseText(JSON.stringify({ args: [{ key: 'k', value: 'v' }], limit: 5 }))).toMatchObject({ ok: true, value: { args: { k: 'v' }, limit: 5 } });
  });

  it('the prompt\'s output entry does the same', () => {
    const out = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: S.ArgsLimit }]).get('output');
    expect(out.strict).toBe(true);
    expect(out.parseText(JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }))).toMatchObject({ ok: true, value: { args: { a: 'b' } } });
    // Non-strict entry: the raw pairs are a wrong answer, reported at the model's path.
    const lenient = ModelProfile.of(LENIENT).request([{ kind: 'output', schema: S.ArgsLimit }]).get('output');
    const res = lenient.parseText(JSON.stringify({ args: [{ key: 'a', value: 'b' }] }));
    expect(!res.ok && res.issues[0]?.path).toEqual(['args']);
  });
});

// ============================================================================
// schema-wire-records.test.ts
// ============================================================================

describe('schemas that crossed a JSON wire (core:schema-wire-records.test.ts)', () => {
  it('a record rebuilt from JSON Schema is sent as pairs on OpenAI strict and decodes back (:15)', () => {
    const report = { unsupported: [] as string[] };
    const W = fromJSONSchema(S.WIRE_RECORD_JSON as unknown as JsonSchema, report);
    expect(report.unsupported).toEqual([]);
    const text = JSON.stringify(W.render(OPENAI_STRICT).jsonSchema);
    expect(text).not.toContain('propertyNames');
    expect(text).toContain('"key"');
    expect(W.render(OPENAI_STRICT).parse({ props: [{ key: 'a', value: 1 }] })).toMatchObject({ ok: true, value: { props: { a: 1 } } });
  });

  it('an empty object (a tool with no args) stays an object; objects with fields keep them (:24, :30)', () => {
    expect(fromJSONSchema({ type: 'object', properties: {} }).render(OPENAI_STRICT).jsonSchema.type).toBe('object');
    expect(JSON.stringify(fromJSONSchema({ type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }).render(OPENAI_STRICT).jsonSchema)).toContain('"a"');
  });

  it('a back-reference to a named union is one $ref, not the union again (:43)', () => {
    const text = JSON.stringify(fromJSONSchema(S.WIRE_NAMED_UNION_JSON as unknown as JsonSchema).render(OPENAI_STRICT).jsonSchema);
    expect((text.match(/"anyOf"/g) ?? []).length).toBe(1);
    // DELIBERATE: core renamed the def by its `aid` ('Type'); a JSON import keeps the $defs name.
    expect(text).toContain('"inner":{"$ref":"#/$defs/T"}');
  });

  it('(was GAP) namespaced def names — "api/HttpHeader" must become a $ref every provider can resolve (:34)', () => {
    const js = S.HttpHeaders.render(OPENAI_STRICT).jsonSchema;
    const text = JSON.stringify(js);
    // `#/$defs/api/HttpHeader` is a JSON pointer to $defs → api → HttpHeader, which doesn't exist.
    expect(text).not.toContain('#/$defs/api/');
    expect(validate(js, { a: { key: 'x' }, b: { key: 'y' } })).toEqual([]);
  });
});
