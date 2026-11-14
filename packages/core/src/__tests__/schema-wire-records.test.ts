/**
 * A schema that crossed a JSON wire comes back from zod's `fromJSONSchema` with
 * its records as field-less objects with an open tail. Under a strict dialect
 * that encodes records as pairs, such an object is a record: it must reach the
 * model as pairs, not as an object with no properties that only `{}` fits.
 */
import { z } from 'zod';
import { OPENAI_STRICT } from '../schema/dialects/openai';
import { strictify } from '../schema/strictify';
import { toJSONSchema } from '../schema/to-json-schema';

describe('records rebuilt from JSON schema', () => {
  const wire = { type: 'object', properties: { props: { type: 'object', additionalProperties: { type: 'number' } } }, required: ['props'] };

  it('are sent as pairs under OpenAI strict, and decode back to a record', () => {
    const rebuilt = z.fromJSONSchema(wire as never) as z.ZodType;
    const strict = strictify(rebuilt, OPENAI_STRICT);
    const json = JSON.stringify(toJSONSchema(strict, OPENAI_STRICT));
    expect(json).not.toContain('propertyNames');
    expect(json).toContain('"key"');
    expect(strict.parse({ props: [{ key: 'a', value: 1 }] })).toEqual({ props: { a: 1 } });
  });

  it('leave an empty object (a tool with no args) an object', () => {
    const wire = z.toJSONSchema(z.object({}), { io: 'input' });
    const json = toJSONSchema(strictify(z.fromJSONSchema(wire as never) as z.ZodType, OPENAI_STRICT), OPENAI_STRICT);
    expect(json.type).toBe('object');
  });

  it('leave objects with fields alone', () => {
    const rebuilt = z.fromJSONSchema({ type: 'object', properties: { a: { type: 'number' } }, required: ['a'] } as never) as z.ZodType;
    const json = toJSONSchema(strictify(rebuilt, OPENAI_STRICT), OPENAI_STRICT);
    expect(JSON.stringify(json)).toContain('"a"');
  });
});

describe('def names', () => {
  it('a namespaced aid (api/HttpHeader) becomes a ref every provider can resolve', () => {
    const header = z.object({ key: z.string() }).meta({ aid: 'api/HttpHeader' });
    const json = toJSONSchema(z.object({ a: header, b: header }), OPENAI_STRICT);
    const text = JSON.stringify(json);
    expect(text).not.toContain('#/$defs/api/');
    expect(text).toContain('#/$defs/api_HttpHeader');
    expect(Object.keys(json.$defs ?? {})).toContain('api_HttpHeader');
  });
});

describe('named recursive defs rebuilt from JSON schema', () => {
  it('a back-reference to a named union is one $ref, not the union again', () => {
    const big = { anyOf: [{ type: 'object', properties: { name: { type: 'string', const: 'a' } }, required: ['name'] }, { type: 'object', properties: { name: { type: 'string', const: 'b' }, inner: { $ref: '#/$defs/T' } }, required: ['name', 'inner'] }] };
    const wire = { type: 'object', properties: { x: { description: 'first', $ref: '#/$defs/T' }, y: { $ref: '#/$defs/T' } }, required: ['x', 'y'], $defs: { T: { aid: 'Type', $ref: '#/$defs/U' }, U: big } };
    const json = toJSONSchema(strictify(z.fromJSONSchema(wire as never) as z.ZodType, OPENAI_STRICT), OPENAI_STRICT);
    const text = JSON.stringify(json);
    expect((text.match(/"anyOf"/g) ?? []).length).toBe(1);
    expect(text).toContain('"inner":{"$ref":"#/$defs/Type"}');
  });
});

