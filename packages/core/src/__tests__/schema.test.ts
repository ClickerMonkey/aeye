/**
 * Schema Tests
 *
 * Comprehensive tests for schema.ts, focusing on:
 * - strict and non-strict behavior
 * - optional() schemas with null/undefined conversion
 * - JSON schema generation for all schema types
 * - nullable fields in strict mode
 */

import z from 'zod';
import { strictify, toJSONSchema, JSONSchema } from '../schema';

type JS = JSONSchema; //z.core.JSONSchema.JSONSchema;

function js(schema?: JS): JS
function js(schema?: JS[]): JS[]
function js(schema?: JS | JS[]): JS | JS[] {
  if (Array.isArray(schema)) {
    return schema.map(s => js(s));
  }
  if (typeof schema === 'boolean') {
    throw new Error('Boolean JSONSchema not supported in this test utility');
  }
  return schema as JS;
}

describe('Schema Utilities', () => {
  describe('strictify', () => {
    describe('ZodOptional - null to undefined conversion', () => {
      it('should convert null to undefined on parse in strict mode', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const strictSchema = strictify(schema);

        // Parse with null value
        const result = strictSchema.parse({
          name: 'John',
          age: null,
        });

        expect(result).toEqual({
          name: 'John',
          age: undefined,
        });
      });

      it('should accept null, undefined, and omission for optional fields', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const strictSchema = strictify(schema);

        // Passing undefined should work
        const result1 = strictSchema.parse({
          name: 'John',
          age: undefined,
        });
        expect(result1.age).toBeUndefined();

        // Omitting the field should also work
        const result2 = strictSchema.parse({
          name: 'John',
        });
        expect(result2.age).toBeUndefined();

        // Passing null should work and convert to undefined
        const result3 = strictSchema.parse({
          name: 'John',
          age: null,
        });
        expect(result3.age).toBeUndefined();
      });

      it('should preserve non-null values', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          name: 'John',
          age: 25,
        });

        expect(result).toEqual({
          name: 'John',
          age: 25,
        });
      });

      it('should handle multiple optional fields', () => {
        const schema = z.object({
          required: z.string(),
          optional1: z.string().optional(),
          optional2: z.number().optional(),
          optional3: z.boolean().optional(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          required: 'test',
          optional1: null,
          optional2: null,
          optional3: true,
        });

        expect(result).toEqual({
          required: 'test',
          optional1: undefined,
          optional2: undefined,
          optional3: true,
        });
      });

      it('should handle nested optional fields', () => {
        const schema = z.object({
          user: z.object({
            name: z.string(),
            email: z.string().optional(),
          }),
          metadata: z.object({
            tags: z.array(z.string()).optional(),
          }).optional(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          user: {
            name: 'John',
            email: null,
          },
          metadata: null,
        });

        expect(result).toEqual({
          user: {
            name: 'John',
            email: undefined,
          },
          metadata: undefined,
        });
      });
    });

    describe('ZodObject', () => {
      it('should transform nested objects', () => {
        const schema = z.object({
          outer: z.object({
            inner: z.string().optional(),
          }),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          outer: {
            inner: null,
          },
        });

        expect(result.outer.inner).toBeUndefined();
      });

      it('should preserve required fields', () => {
        const schema = z.object({
          required: z.string(),
          optional: z.string().optional(),
        });

        const strictSchema = strictify(schema);

        expect(() => {
          strictSchema.parse({
            optional: null,
          });
        }).toThrow();
      });
    });

    describe('ZodArray', () => {
      it('should transform arrays with optional elements', () => {
        const schema = z.object({
          items: z.array(z.object({
            name: z.string(),
            value: z.number().optional(),
          })),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          items: [
            { name: 'a', value: 1 },
            { name: 'b', value: null },
          ],
        });

        expect(result.items[0].value).toBe(1);
        expect(result.items[1].value).toBeUndefined();
      });

      it('should handle optional arrays', () => {
        const schema = z.object({
          items: z.array(z.string()).optional(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          items: null,
        });

        expect(result.items).toBeUndefined();
      });
    });

    describe('ZodRecord', () => {
      it('should transform records with optional values', () => {
        const schema = z.object({
          data: z.record(z.string(), z.number().optional()),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          data: [
            { key: 'a', value: 1 },
            { key: 'b', value: null },
          ],
        });

        expect(result.data).toEqual({
          a: 1,
          b: undefined,
        });
      });

      it('should handle optional records', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).optional(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          data: null,
        });

        expect(result.data).toBeUndefined();
      });
    });

    describe('ZodUnion', () => {
      it('should transform unions with optional fields', () => {
        const schema = z.object({
          value: z.union([
            z.object({ type: z.literal('a'), data: z.string().optional() }),
            z.object({ type: z.literal('b'), count: z.number().optional() }),
          ]),
        });

        const strictSchema = strictify(schema);

        const result1 = strictSchema.parse({
          value: { type: 'a', data: null },
        });
        if (result1.value.type === 'a') {
          expect(result1.value.data).toBeUndefined();
        }

        const result2 = strictSchema.parse({
          value: { type: 'b', count: null },
        });
        if (result2.value.type === 'b') {
          expect(result2.value.count).toBeUndefined();
        }
      });
    });

    describe('ZodDiscriminatedUnion', () => {
      it('should transform discriminated unions with optional fields', () => {
        const schema = z.object({
          item: z.discriminatedUnion('type', [
            z.object({ type: z.literal('text'), content: z.string().optional() }),
            z.object({ type: z.literal('number'), value: z.number().optional() }),
          ]),
        });

        const strictSchema = strictify(schema);

        const result1 = strictSchema.parse({
          item: { type: 'text', content: null },
        });
        if (result1.item.type === 'text') {
          expect(result1.item.content).toBeUndefined();
        }

        const result2 = strictSchema.parse({
          item: { type: 'number', value: null },
        });
        if (result2.item.type === 'number') {
          expect(result2.item.value).toBeUndefined();
        }
      });
    });

    describe('ZodNullable', () => {
      it('should preserve nullable fields (different from optional)', () => {
        const schema = z.object({
          value: z.string().nullable(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          value: null,
        });

        expect(result.value).toBeNull();
      });

      it('should preserve non-null values in nullable fields', () => {
        const schema = z.object({
          value: z.string().nullable(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          value: 'test',
        });

        expect(result.value).toBe('test');
      });

      it('should require nullable fields to be present', () => {
        const schema = z.object({
          value: z.string().nullable(),
        });

        const strictSchema = strictify(schema);

        // Omitting nullable field should fail
        expect(() => {
          strictSchema.parse({});
        }).toThrow();
      });

      it('should handle nullable().optional() - null becomes null (not undefined)', () => {
        const schema = z.object({
          name: z.string(),
          value: z.string().nullable().optional(),
        });

        const strictSchema = strictify(schema);

        // Passing null should preserve null (not convert to undefined)
        const result1 = strictSchema.parse({
          name: 'test',
          value: null,
        });
        expect(result1.value).toBeNull();

        // Passing undefined should preserve undefined
        const result2 = strictSchema.parse({
          name: 'test',
          value: undefined,
        });
        expect(result2.value).toBeUndefined();

        // Omitting the field should result in undefined
        const result3 = strictSchema.parse({
          name: 'test',
        });
        expect(result3.value).toBeUndefined();

        // Passing a real value should work
        const result4 = strictSchema.parse({
          name: 'test',
          value: 'actual',
        });
        expect(result4.value).toBe('actual');
      });

      it('should handle optional().nullable() - null becomes null (not undefined)', () => {
        const schema = z.object({
          name: z.string(),
          value: z.string().optional().nullable(),
        });

        const strictSchema = strictify(schema);

        // Passing null should preserve null
        const result1 = strictSchema.parse({
          name: 'test',
          value: null,
        });
        expect(result1.value).toBeNull();

        // Passing undefined should preserve undefined
        const result2 = strictSchema.parse({
          name: 'test',
          value: undefined,
        });
        expect(result2.value).toBeUndefined();

        // Omitting the field should result in undefined
        const result3 = strictSchema.parse({
          name: 'test',
        });
        expect(result3.value).toBeUndefined();

        // Passing a real value should work
        const result4 = strictSchema.parse({
          name: 'test',
          value: 'actual',
        });
        expect(result4.value).toBe('actual');
      });

      it('should handle nested nullable fields', () => {
        const schema = z.object({
          user: z.object({
            name: z.string(),
            email: z.string().nullable(),
            bio: z.string().nullable().optional(),
          }),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          user: {
            name: 'John',
            email: null,
            bio: null,
          },
        });

        expect(result.user.name).toBe('John');
        expect(result.user.email).toBeNull();
        expect(result.user.bio).toBeNull();
      });

      it('should handle arrays with nullable elements', () => {
        const schema = z.object({
          items: z.array(z.string().nullable()),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          items: ['a', null, 'b', null],
        });

        expect(result.items).toEqual(['a', null, 'b', null]);
      });

      it('should handle nullable arrays with nullable elements', () => {
        const schema = z.object({
          items: z.array(z.string().nullable()).nullable(),
        });

        const strictSchema = strictify(schema);

        // Null array
        const result1 = strictSchema.parse({
          items: null,
        });
        expect(result1.items).toBeNull();

        // Array with null elements
        const result2 = strictSchema.parse({
          items: ['a', null, 'b'],
        });
        expect(result2.items).toEqual(['a', null, 'b']);
      });
    });

    describe('ZodIntersection', () => {
      it('should transform intersections with optional fields', () => {
        const schema = z.object({
          data: z.intersection(
            z.object({ a: z.string() }),
            z.object({ b: z.number().optional() })
          ),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          data: { a: 'test', b: null },
        });

        expect(result.data.b).toBeUndefined();
      });
    });

    describe('ZodTuple', () => {
      it('should transform tuples with optional elements', () => {
        const schema = z.object({
          tuple: z.tuple([z.string(), z.number().optional()]),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          tuple: ['test', null],
        });

        expect(result.tuple[0]).toBe('test');
        expect(result.tuple[1]).toBeUndefined();
      });
    });

    describe('ZodDefault', () => {
      it('should handle default values with null conversion', () => {
        const schema = z.object({
          value: z.string().default('default'),
        });

        const strictSchema = strictify(schema);

        const result1 = strictSchema.parse({
          value: null,
        });
        expect(result1.value).toBe('default');

        const result2 = strictSchema.parse({
          value: undefined,
        });
        expect(result2.value).toBe('default');

        const result3 = strictSchema.parse({
          value: 'custom',
        });
        expect(result3.value).toBe('custom');
      });
    });

    describe('ZodLazy', () => {
      it('should handle lazy schemas with optional fields', () => {
        type Node = {
          value: string;
          children?: Node[];
        };

        const nodeSchema: z.ZodType<Node> = z.lazy(() =>
          z.object({
            value: z.string(),
            children: z.array(nodeSchema).optional(),
          })
        );

        const schema = z.object({
          root: nodeSchema,
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          root: {
            value: 'root',
            children: [
              { value: 'child1', children: null },
              { value: 'child2' },
            ],
          },
        });

        expect(result.root.children![0].children).toBeUndefined();
        expect(result.root.children![1].children).toBeUndefined();
      });
    });

    describe('ZodCodec', () => {
      it('should preserve codec transformations', () => {
        const innerSchema = z.object({
          value: z.string().optional(),
        });

        const schema = z.object({
          data: z.codec(
            z.object({ raw: z.string() }),
            innerSchema,
            {
              decode: (val) => ({ value: val.raw }),
              encode: (val) => ({ raw: val.value || 'empty' }),
            }
          ),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          data: { raw: 'test' },
        });

        expect(result.data.value).toBe('test');
      });
    });

    describe('ZodPipe', () => {
      it('should preserve pipe transformations', () => {
        const schema = z.object({
          value: z.pipe(
            z.string(),
            z.string().transform((s) => s.toUpperCase())
          ).optional(),
        });

        const strictSchema = strictify(schema);

        const result1 = strictSchema.parse({
          value: 'test',
        });
        expect(result1.value).toBe('TEST');

        const result2 = strictSchema.parse({
          value: null,
        });
        expect(result2.value).toBeUndefined();
      });
    });

    describe('Primitive types', () => {
      it('should preserve string schema', () => {
        const schema = z.object({
          value: z.string(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          value: 'test',
        });

        expect(result.value).toBe('test');
      });

      it('should preserve number schema', () => {
        const schema = z.object({
          value: z.number(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          value: 42,
        });

        expect(result.value).toBe(42);
      });

      it('should preserve boolean schema', () => {
        const schema = z.object({
          value: z.boolean(),
        });

        const strictSchema = strictify(schema);

        const result = strictSchema.parse({
          value: true,
        });

        expect(result.value).toBe(true);
      });
    });

    describe('Metadata preservation', () => {
      it('should preserve description', () => {
        const schema = z.object({
          value: z.string().optional().describe('A test value'),
        });

        const strictSchema = strictify(schema);

        expect(strictSchema.shape.value.description).toBe('A test value');
      });

      it('should preserve metadata', () => {
        const schema = z.object({
          value: z.string().optional().meta({ custom: 'data' }),
        });

        const strictSchema = strictify(schema);

        expect(strictSchema.shape.value.meta()).toEqual({ custom: 'data' });
      });
    });

    describe('open objects (catchall)', () => {
      // `strictify` rebuilds every object via `z.object(shape)`, which drops
      // the catchall. That silently closed every open TypeDef the moment a
      // strict dialect was chosen, while `toJSONSchema` went on emitting the
      // catchall as `additionalProperties` — the two disagreed about the same
      // schema, and the only symptom was extra keys vanishing at parse time.
      it('preserves .catchall() so an open object stays open', () => {
        const schema = z.object({ name: z.string() }).catchall(z.any());

        const strictSchema = strictify(schema);

        const parsed = strictSchema.parse({ name: 'x', extra: 1, nested: { a: true } });
        expect(parsed).toEqual({ name: 'x', extra: 1, nested: { a: true } });
      });

      it('preserves a TYPED catchall and validates through it', () => {
        const schema = z.object({ name: z.string() }).catchall(z.number());

        const strictSchema = strictify(schema);

        expect(strictSchema.parse({ name: 'x', count: 2 })).toEqual({ name: 'x', count: 2 });
        expect(() => strictSchema.parse({ name: 'x', count: 'nope' })).toThrow();
      });

      it('preserves z.strictObject (catchall of never) so unknown keys still reject', () => {
        const schema = z.strictObject({ name: z.string() });

        const strictSchema = strictify(schema);

        expect(() => strictSchema.parse({ name: 'x', extra: 1 })).toThrow();
      });

      it('leaves a plain object closed-by-stripping, as before', () => {
        const schema = z.object({ name: z.string() });

        const strictSchema = strictify(schema);

        expect(strictSchema.parse({ name: 'x', extra: 1 })).toEqual({ name: 'x' });
      });

      it('strictifies the catchall VALUE type too, not just the shape', () => {
        // The catchall value has to travel the same rewrite road as any other
        // slot, or an OpenAI-strict record nested in the open tail would be
        // validated against the natural shape while the wire carries pairs.
        const schema = z.object({ name: z.string() })
          .catchall(z.object({ tags: z.record(z.string(), z.string()) }));

        const strictSchema = strictify(schema);

        // Array-of-pairs is the OpenAI-strict wire shape for a record; the
        // strictified schema must accept it inside the catchall value.
        const parsed = strictSchema.parse({
          name: 'x',
          anything: { tags: [{ key: 'a', value: 'b' }] },
        });
        expect(parsed.anything.tags).toEqual({ a: 'b' });
      });
    });
  });

  describe('toJSONSchema', () => {
    describe('Strict mode - optional fields', () => {
      it('should make optional fields nullable and required in JSON schema', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.type).toBe('object');
        expect(jsonSchema.required).toEqual(['name', 'age']);
        expect(js(jsonSchema.properties!.name).type).toBe('string');
        expect(js(jsonSchema.properties!.age).type).toEqual(['number', 'null']);
      });

      it('should handle multiple optional fields', () => {
        const schema = z.object({
          required: z.string(),
          optional1: z.string().optional(),
          optional2: z.number().optional(),
          optional3: z.boolean().optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.required).toEqual(['required', 'optional1', 'optional2', 'optional3']);
        expect(js(jsonSchema.properties!.optional1).type).toEqual(['string', 'null']);
        expect(js(jsonSchema.properties!.optional2).type).toEqual(['number', 'null']);
        expect(js(jsonSchema.properties!.optional3).type).toEqual(['boolean', 'null']);
      });

      it('should set additionalProperties to false', () => {
        const schema = z.object({
          name: z.string(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.additionalProperties).toBe(false);
      });

      it('should handle nested objects with optional fields', () => {
        const schema = z.object({
          user: z.object({
            name: z.string(),
            email: z.string().optional(),
          }),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(js(jsonSchema.properties!.user).required).toEqual(['name', 'email']);
        expect(js(js(jsonSchema.properties!.user).properties!.email).type).toEqual(['string', 'null']);
      });

      it('should handle arrays with optional element fields', () => {
        const schema = z.object({
          items: z.array(z.object({
            name: z.string(),
            value: z.number().optional(),
          })),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(js(jsonSchema.properties!.items).type).toBe('array');
        expect((js(jsonSchema.properties!.items).items as JS).required).toEqual(['name', 'value']);
        expect(js((js(jsonSchema.properties!.items).items as JS).properties!.value).type).toEqual(['number', 'null']);
      });

      it('should handle optional arrays', () => {
        const schema = z.object({
          items: z.array(z.string()).optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.required).toEqual(['items']);
        // The array itself should be nullable (wrapped in anyOf with null)
        const itemsSchema = js(jsonSchema.properties!.items);
        expect(itemsSchema.anyOf).toBeDefined();
        expect(itemsSchema.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
        expect(itemsSchema.anyOf!.some((s: JS) => s.type === 'array')).toBe(true);
      });

      it('should handle complex nested structures', () => {
        const schema = z.object({
          id: z.string(),
          metadata: z.object({
            tags: z.array(z.string()).optional(),
            author: z.object({
              name: z.string(),
              email: z.string().optional(),
            }).optional(),
          }),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.required).toEqual(['id', 'metadata']);
        const metadataSchema = js(jsonSchema.properties!.metadata);
        expect(metadataSchema.required).toEqual(['tags', 'author']);

        // Optional fields are wrapped in anyOf with null
        const tagsSchema = js(metadataSchema.properties!.tags);
        expect(tagsSchema.anyOf).toBeDefined();
        expect(tagsSchema.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);

        const authorSchema = js(metadataSchema.properties!.author);
        expect(authorSchema.anyOf).toBeDefined();
        expect(authorSchema.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
      });
    });

    describe('Non-strict mode', () => {
      it('should make optional fields truly optional in JSON schema', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const jsonSchema = toJSONSchema(schema, false);

        expect(jsonSchema.required).toEqual(['name']);
        expect(jsonSchema.required).not.toContain('age');
      });

      it('should not add null type to optional fields', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const jsonSchema = toJSONSchema(schema, false);

        expect(js(jsonSchema.properties!.age).type).toBe('number');
        expect(js(jsonSchema.properties!.age).type).not.toContain('null');
      });

      it('should allow additionalProperties by default', () => {
        const schema = z.object({
          name: z.string(),
        });

        const jsonSchema = toJSONSchema(schema, false);

        expect(jsonSchema.additionalProperties).not.toBe(false);
      });
    });

    describe('Special cases', () => {
      it('should handle schemas with descriptions', () => {
        const schema = z.object({
          name: z.string().describe('User name'),
          age: z.number().optional().describe('User age'),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(js(jsonSchema.properties!.name).description).toBe('User name');
        expect(js(jsonSchema.properties!.age).description).toBe('User age');
      });

      it('should handle schemas with default values', () => {
        const schema = z.object({
          name: z.string(),
          role: z.string().default('user'),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        console.log(jsonSchema); // TODO REMOVE

        expect(js(jsonSchema.properties!.role).default).toBe('user');
      });

      it('should handle enums', () => {
        const schema = z.object({
          status: z.enum(['active', 'inactive']),
          priority: z.enum(['low', 'medium', 'high']).optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(js(jsonSchema.properties!.status).enum).toEqual(['active', 'inactive']);
        expect(jsonSchema.required).toContain('priority');
      });

      it('should handle unions', () => {
        const schema = z.object({
          value: z.union([z.string(), z.number()]).optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.required).toContain('value');
        // Should have null as an option
        expect(js(jsonSchema.properties!.value).anyOf || js(jsonSchema.properties!.value).type).toBeDefined();
      });

      it('should handle records', () => {
        const schema = z.object({
          data: z.record(z.string(), z.number()),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Records are encoded as arrays in strict mode
        expect(js(jsonSchema.properties!.data).type).toBe('array');
      });

      it('should handle nullable fields (different from optional)', () => {
        const schema = z.object({
          value: z.string().nullable(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Nullable should already include null type
        expect(js(jsonSchema.properties!.value).type).toContain('null');
        // Nullable fields are required (must be present, but can be null)
        expect(jsonSchema.required).toContain('value');
      });

      it('should handle nullable().optional() in JSON schema', () => {
        const schema = z.object({
          required: z.string(),
          nullableOptional: z.string().nullable().optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // In strict mode, optional fields become required but nullable
        expect(jsonSchema.required).toEqual(['required', 'nullableOptional']);
        // Should include both string and null types
        expect(js(jsonSchema.properties!.nullableOptional).type).toContain('null');
        expect(js(jsonSchema.properties!.nullableOptional).type).toContain('string');
      });

      it('should handle optional().nullable() in JSON schema', () => {
        const schema = z.object({
          required: z.string(),
          optionalNullable: z.string().optional().nullable(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // In strict mode, optional fields become required but nullable
        expect(jsonSchema.required).toEqual(['required', 'optionalNullable']);
        // Should include both string and null types
        expect(js(jsonSchema.properties!.optionalNullable).type).toContain('null');
        expect(js(jsonSchema.properties!.optionalNullable).type).toContain('string');
      });

      it('should handle mixed nullable, optional, and regular fields', () => {
        const schema = z.object({
          required: z.string(),
          nullable: z.string().nullable(),
          optional: z.string().optional(),
          nullableOptional: z.string().nullable().optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // All fields should be required in strict mode
        expect(jsonSchema.required).toEqual(['required', 'nullable', 'optional', 'nullableOptional']);

        // Required field - just string
        expect(js(jsonSchema.properties!.required).type).toBe('string');

        // Nullable field - string or null, but must be present
        const nullableType = js(jsonSchema.properties!.nullable).type;
        const nullableTypes = Array.isArray(nullableType) ? nullableType : [nullableType];
        expect(nullableTypes).toContain('string');
        expect(nullableTypes).toContain('null');

        // Optional field - string or null in strict mode
        expect(js(jsonSchema.properties!.optional).type).toEqual(['string', 'null']);

        // Nullable optional field - string or null
        expect(js(jsonSchema.properties!.nullableOptional).type).toContain('string');
        expect(js(jsonSchema.properties!.nullableOptional).type).toContain('null');
      });

      it('should handle nullable arrays in JSON schema', () => {
        const schema = z.object({
          items: z.array(z.string()).nullable(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Should be required and nullable (wrapped in anyOf with null)
        expect(jsonSchema.required).toContain('items');
        const itemsSchema = js(jsonSchema.properties!.items);
        expect(itemsSchema.anyOf).toBeDefined();
        expect(itemsSchema.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
        expect(itemsSchema.anyOf!.some((s: JS) => s.type === 'array')).toBe(true);
      });

      it('should handle nested nullable fields in JSON schema', () => {
        const schema = z.object({
          user: z.object({
            name: z.string(),
            email: z.string().nullable(),
            bio: z.string().nullable().optional(),
          }),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.required).toEqual(['user']);
        expect(js(jsonSchema.properties!.user).required).toEqual(['name', 'email', 'bio']);

        // email is nullable - should have null type
        const emailType = js(js(jsonSchema.properties!.user).properties!.email).type;
        const emailTypes = Array.isArray(emailType) ? emailType : [emailType];
        expect(emailTypes).toContain('null');

        // bio is nullable and optional - should have null type
        expect(js(js(jsonSchema.properties!.user).properties!.bio).type).toContain('null');
      });
    });

    describe('Edge cases', () => {
      it('should handle empty objects', () => {
        const schema = z.object({});

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.type).toBe('object');
        expect(jsonSchema.properties).toEqual({});
        expect(jsonSchema.required).toEqual([]);
      });

      it('should handle deeply nested optional fields', () => {
        const schema = z.object({
          level1: z.object({
            level2: z.object({
              level3: z.object({
                value: z.string().optional(),
              }).optional(),
            }).optional(),
          }).optional(),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // All levels should be required but nullable (wrapped in anyOf with null)
        expect(jsonSchema.required).toEqual(['level1']);
        const level1Schema = js(jsonSchema.properties!.level1);
        expect(level1Schema.anyOf).toBeDefined();
        expect(level1Schema.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
      });

      it('should handle mixed required and optional fields at multiple levels', () => {
        const schema = z.object({
          required1: z.string(),
          optional1: z.string().optional(),
          nested: z.object({
            required2: z.number(),
            optional2: z.number().optional(),
            deepNested: z.object({
              required3: z.boolean(),
              optional3: z.boolean().optional(),
            }),
          }),
        });

        const strictSchema = strictify(schema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.required).toEqual(['required1', 'optional1', 'nested']);
        expect(js(jsonSchema.properties!.nested).required).toEqual(['required2', 'optional2', 'deepNested']);
        expect(js(js(jsonSchema.properties!.nested).properties!.deepNested).required).toEqual(['required3', 'optional3']);
      });
    });
  });

  describe('Integration tests - strict mode end-to-end', () => {
    it('should handle full workflow: define -> strictify -> toJSONSchema -> parse', () => {
      const schema = z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().optional(),
        age: z.number().optional(),
        settings: z.object({
          theme: z.string(),
          notifications: z.boolean().optional(),
        }),
      });

      // Step 1: Strictify
      const strictSchema = strictify(schema);

      // Step 2: Generate JSON Schema
      const jsonSchema = toJSONSchema(strictSchema, true);

      // Verify JSON Schema has all fields required and optional ones nullable
      expect(jsonSchema.required).toEqual(['id', 'name', 'email', 'age', 'settings']);
      expect(js(jsonSchema.properties!.email).type).toEqual(['string', 'null']);
      expect(js(jsonSchema.properties!.age).type).toEqual(['number', 'null']);
      expect(js(jsonSchema.properties!.settings).required).toEqual(['theme', 'notifications']);
      expect(js(js(jsonSchema.properties!.settings).properties!.notifications).type).toEqual(['boolean', 'null']);

      // Step 3: Parse data with nulls
      const result = strictSchema.parse({
        id: '123',
        name: 'John',
        email: null,
        age: null,
        settings: {
          theme: 'dark',
          notifications: null,
        },
      });

      // Verify nulls converted to undefined
      expect(result).toEqual({
        id: '123',
        name: 'John',
        email: undefined,
        age: undefined,
        settings: {
          theme: 'dark',
          notifications: undefined,
        },
      });
    });

    it('should handle array of objects with optional fields', () => {
      const schema = z.object({
        users: z.array(z.object({
          name: z.string(),
          email: z.string().optional(),
        })),
      });

      const strictSchema = strictify(schema);
      const jsonSchema = toJSONSchema(strictSchema, true);

      expect((js(jsonSchema.properties!.users).items as JS).required).toEqual(['name', 'email']);
      expect(js((js(jsonSchema.properties!.users).items as JS).properties!.email).type).toEqual(['string', 'null']);

      const result = strictSchema.parse({
        users: [
          { name: 'Alice', email: 'alice@example.com' },
          { name: 'Bob', email: null },
        ],
      });

      expect(result.users[0].email).toBe('alice@example.com');
      expect(result.users[1].email).toBeUndefined();
    });
  });

  describe('Type Helper Schema Generation', () => {
    describe('Recursive WhereClause with and/or arrays', () => {
      it('should correctly generate JSON schema for recursive schemas with getters', () => {
        // This test verifies that Zod's JSON schema generator + our typeOverride
        // properly handles getters in object schemas for recursive types.

        // Build the where schema recursively using getters (current implementation in type.ts)
        const whereSchema: z.ZodType<any> = z.object({
          get and() {
            return z.array(whereSchema).optional();
          },
          get or() {
            return z.array(whereSchema).optional();
          },
          get not() {
            return whereSchema.optional();
          },
          name: z.object({
            equals: z.string().optional(),
            contains: z.string().optional(),
          }).optional(),
          age: z.object({
            equals: z.number().optional(),
            gte: z.number().optional(),
          }).optional(),
          active: z.object({
            equals: z.boolean().optional(),
          }).optional(),
        }).meta({ title: 'TestType_where' });

        // Generate JSON schema in strict mode
        const strictSchema = strictify(whereSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Properties should be properly defined
        expect(jsonSchema.properties).toBeDefined();
        expect(jsonSchema.properties!.and).toBeDefined();
        expect(jsonSchema.properties!.or).toBeDefined();
        expect(jsonSchema.properties!.not).toBeDefined();

        // The properties should have proper $ref to definitions
        const andProp = js(jsonSchema.properties!.and);

        // The 'and' property is a reference to a definition
        expect(andProp.$ref).toBeDefined();
        expect(jsonSchema.$defs).toBeDefined();

        // Follow the reference to check the actual schema
        const refName = andProp.$ref!.split('/').pop()!;
        const andDef = js(jsonSchema.$defs![refName]);

        // The definition should be an anyOf with array and null
        expect(andDef.anyOf).toBeDefined();
        expect(andDef.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
        const arrayOption = andDef.anyOf!.find((s: JS) => s.type === 'array');
        expect(arrayOption).toBeDefined();
        expect(arrayOption!.items).toBeDefined();

        // The Zod schema also works for parsing (getters are evaluated at runtime)
        const testData = {
          and: [
            { name: { equals: 'test' } }
          ]
        };
        expect(() => strictSchema.parse(testData)).not.toThrow();
      });

      it('should correctly generate JSON schema with z.lazy approach', () => {
        // Define the schema using z.lazy for recursion
        type Where = {
          and?: Where[];
          or?: Where[];
          not?: Where;
          name?: { equals?: string; contains?: string };
          age?: { equals?: number; gte?: number };
        }

        const whereSchemaNoGetters: z.ZodType<Where> = z.object({
          and: z.array(z.lazy(() => whereSchemaNoGetters)).optional(),
          or: z.array(z.lazy(() => whereSchemaNoGetters)).optional(),
          not: z.lazy(() => whereSchemaNoGetters).optional(),
          name: z.object({
            equals: z.string().optional(),
            contains: z.string().optional(),
          }).optional(),
          age: z.object({
            equals: z.number().optional(),
            gte: z.number().optional(),
          }).optional(),
        }).meta({ title: 'TestType_where_no_getters' });

        // Generate JSON schema in strict mode
        const strictSchema = strictify(whereSchemaNoGetters);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Properties should be properly defined
        expect(jsonSchema.properties).toBeDefined();
        expect(jsonSchema.properties!.and).toBeDefined();
        expect(jsonSchema.properties!.or).toBeDefined();
        expect(jsonSchema.properties!.not).toBeDefined();

        const andProp = js(jsonSchema.properties!.and);

        // After our fix, recursive references work correctly
        // The 'and' property is a reference to a definition
        expect(andProp.$ref).toBeDefined();
        expect(jsonSchema.$defs).toBeDefined();

        // Follow the reference to check the actual schema
        const refName = andProp.$ref!.split('/').pop()!;
        const andDef = js(jsonSchema.$defs![refName]);

        // The definition should be an anyOf with array and null
        expect(andDef.anyOf).toBeDefined();
        expect(andDef.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
        const arrayOption = andDef.anyOf!.find((s: JS) => s.type === 'array');
        expect(arrayOption).toBeDefined();
        expect(arrayOption!.items).toBeDefined();
      });

      it('should correctly generate JSON schema with external z.lazy references', () => {
        // This test uses a simpler pattern that avoids the mutual recursion issue
        // The recommended pattern is to use z.lazy directly within the object definition
        // rather than creating separate lazy wrappers

        type WhereClauseType = {
          and?: WhereClauseType[];
          or?: WhereClauseType[];
          not?: WhereClauseType;
          name?: { equals?: string; contains?: string };
          age?: { equals?: number; gte?: number };
        };

        // Recommended: Define recursion directly in the object definition
        const whereClause: z.ZodType<WhereClauseType> = z.object({
          and: z.array(z.lazy(() => whereClause)).optional(),
          or: z.array(z.lazy(() => whereClause)).optional(),
          not: z.lazy(() => whereClause).optional(),
          name: z.object({
            equals: z.string().optional(),
            contains: z.string().optional(),
          }).optional(),
          age: z.object({
            equals: z.number().optional(),
            gte: z.number().optional(),
          }).optional(),
        }).meta({ title: 'TestType_where_fixed' });

        // Generate JSON schema in strict mode
        const strictSchema = strictify(whereClause);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Properties are defined
        expect(jsonSchema.properties).toBeDefined();
        expect(jsonSchema.properties!.and).toBeDefined();
        expect(jsonSchema.properties!.or).toBeDefined();
        expect(jsonSchema.properties!.not).toBeDefined();

        const andProp = js(jsonSchema.properties!.and);

        // The property should have a $ref to the array definition
        expect(andProp.$ref).toBeDefined();
        expect(jsonSchema.$defs).toBeDefined();

        // Follow the reference to check the actual schema
        const refName = andProp.$ref!.split('/').pop()!;
        const andDef = js(jsonSchema.$defs![refName]);

        // The definition should be an anyOf with array and null
        expect(andDef.anyOf).toBeDefined();
        expect(andDef.anyOf!.some((s: JS) => s.type === 'null')).toBe(true);
        const arrayOption = andDef.anyOf!.find((s: JS) => s.type === 'array');
        expect(arrayOption).toBeDefined();
        expect(arrayOption!.items).toBeDefined();

        // The Zod schema itself works for parsing
        const testData = {
          and: [
            { name: { contains: 'John' } },
            {
              or: [
                { age: { gte: 18 } },
              ]
            },
          ],
        };
        const result = strictSchema.parse(testData);
        expect(result.and).toBeDefined();
        expect(result.and![0].name?.contains).toBe('John');
      });

      it('should successfully parse nested where clauses with and/or', () => {
        // Build the where schema
        const whereSchema: z.ZodType<any> = z.object({
          get and() {
            return z.array(whereSchema).optional();
          },
          get or() {
            return z.array(whereSchema).optional();
          },
          get not() {
            return whereSchema.optional();
          },
          name: z.object({
            equals: z.string().optional(),
            contains: z.string().optional(),
          }).optional(),
          age: z.object({
            equals: z.number().optional(),
            gte: z.number().optional(),
            lte: z.number().optional(),
          }).optional(),
        }).meta({ title: 'TestType_where' });

        const strictSchema = strictify(whereSchema);

        // Test parsing a complex nested where clause
        const complexWhere = {
          and: [
            { name: { contains: 'John' } },
            {
              or: [
                { age: { gte: 18 } },
                { age: { lte: 65 } },
              ]
            },
          ],
        };

        const result = strictSchema.parse(complexWhere);

        // Verify structure is preserved
        expect(result.and).toBeDefined();
        expect(Array.isArray(result.and)).toBe(true);
        expect(result.and.length).toBe(2);
        expect(result.and[0].name?.contains).toBe('John');
        expect(result.and[1].or).toBeDefined();
        expect(Array.isArray(result.and[1].or)).toBe(true);
      });

      it('should handle deeply nested and/or/not combinations', () => {
        const whereSchema: z.ZodType<any> = z.object({
          get and() {
            return z.array(whereSchema).optional();
          },
          get or() {
            return z.array(whereSchema).optional();
          },
          get not() {
            return whereSchema.optional();
          },
          status: z.object({
            equals: z.string().optional(),
          }).optional(),
          priority: z.object({
            equals: z.number().optional(),
          }).optional(),
        }).meta({ title: 'Task_where' });

        const strictSchema = strictify(whereSchema);

        const deeplyNested = {
          and: [
            { status: { equals: 'active' } },
            {
              or: [
                { priority: { equals: 1 } },
                {
                  and: [
                    { priority: { equals: 2 } },
                    {
                      not: {
                        status: { equals: 'archived' }
                      }
                    }
                  ]
                }
              ]
            }
          ]
        };

        const result = strictSchema.parse(deeplyNested);

        expect(result.and[0].status?.equals).toBe('active');
        expect(result.and[1].or[0].priority?.equals).toBe(1);
        expect(result.and[1].or[1].and[0].priority?.equals).toBe(2);
        expect(result.and[1].or[1].and[1].not?.status?.equals).toBe('archived');
      });
    });

    describe('Field conditions for different types', () => {
      it('should handle string field conditions', () => {
        const stringConditionSchema = z.object({
          equals: z.string().optional(),
          contains: z.string().optional(),
          startsWith: z.string().optional(),
          endsWith: z.string().optional(),
          oneOf: z.array(z.string()).optional(),
          isEmpty: z.boolean().optional(),
        }).optional();

        const strictSchema = strictify(stringConditionSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Optional objects in strict mode are wrapped in anyOf with null
        expect(jsonSchema.anyOf).toBeDefined();
        expect(jsonSchema.anyOf![0]).toBeDefined();
        const objectSchema = js(jsonSchema.anyOf![0]);
        expect(objectSchema.properties).toBeDefined();
        expect(objectSchema.properties!.equals).toBeDefined();
        expect(objectSchema.properties!.contains).toBeDefined();
        expect(objectSchema.properties!.startsWith).toBeDefined();
        expect(objectSchema.properties!.endsWith).toBeDefined();
        expect(objectSchema.properties!.oneOf).toBeDefined();
        expect(objectSchema.properties!.isEmpty).toBeDefined();
      });

      it('should handle number field conditions', () => {
        const numberConditionSchema = z.object({
          equals: z.number().optional(),
          lt: z.number().optional(),
          lte: z.number().optional(),
          gt: z.number().optional(),
          gte: z.number().optional(),
          oneOf: z.array(z.number()).optional(),
          isEmpty: z.boolean().optional(),
        }).optional();

        const strictSchema = strictify(numberConditionSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Optional objects in strict mode are wrapped in anyOf with null
        expect(jsonSchema.anyOf).toBeDefined();
        const objectSchema = js(jsonSchema.anyOf![0]);
        expect(objectSchema.properties!.lt).toBeDefined();
        expect(objectSchema.properties!.lte).toBeDefined();
        expect(objectSchema.properties!.gt).toBeDefined();
        expect(objectSchema.properties!.gte).toBeDefined();
      });

      it('should handle date field conditions', () => {
        const dateConditionSchema = z.object({
          equals: z.iso.date().optional(),
          before: z.iso.date().optional(),
          after: z.iso.date().optional(),
          oneOf: z.array(z.iso.date()).optional(),
          isEmpty: z.boolean().optional(),
        }).optional();

        const strictSchema = strictify(dateConditionSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Optional objects in strict mode are wrapped in anyOf with null
        expect(jsonSchema.anyOf).toBeDefined();
        const objectSchema = js(jsonSchema.anyOf![0]);
        expect(objectSchema.properties!.before).toBeDefined();
        expect(objectSchema.properties!.after).toBeDefined();
      });

      it('should handle enum field conditions', () => {
        const enumConditionSchema = z.object({
          equals: z.enum(['option1', 'option2', 'option3']).optional(),
          oneOf: z.array(z.enum(['option1', 'option2', 'option3'])).optional(),
          isEmpty: z.boolean().optional(),
        }).optional();

        const strictSchema = strictify(enumConditionSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        // Optional objects in strict mode are wrapped in anyOf with null
        expect(jsonSchema.anyOf).toBeDefined();
        const objectSchema = js(jsonSchema.anyOf![0]);
        expect(objectSchema.properties!.equals).toBeDefined();
        const equalsProp = js(objectSchema.properties!.equals);
        // Enum should have enum property in JSON schema
        expect(equalsProp.enum || equalsProp.anyOf).toBeDefined();
      });
    });

    describe('FieldSet schema with union of field assignments', () => {
      it('should handle array of field/value pairs', () => {
        // Simulating buildFieldSetSchema output
        const fieldSetSchema = z.array(
          z.union([
            z.object({
              field: z.literal('name'),
              value: z.string(),
            }),
            z.object({
              field: z.literal('age'),
              value: z.number(),
            }),
            z.object({
              field: z.literal('active'),
              value: z.boolean(),
            }),
          ])
        ).meta({ title: 'TestType_fieldset' });

        const strictSchema = strictify(fieldSetSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.type).toBe('array');
        expect(jsonSchema.items).toBeDefined();

        // The items should be a union (anyOf) of the different field options
        const items = js(jsonSchema.items as any);
        expect(items.anyOf || items.oneOf).toBeDefined();
      });

      it('should successfully parse field set arrays', () => {
        const fieldSetSchema = z.array(
          z.union([
            z.object({
              field: z.literal('name'),
              value: z.string(),
            }),
            z.object({
              field: z.literal('age'),
              value: z.number().nullable(),
            }),
          ])
        );

        const strictSchema = strictify(fieldSetSchema);

        const fieldSet = [
          { field: 'name', value: 'John Doe' },
          { field: 'age', value: 30 },
          { field: 'age', value: null },
        ];

        const result = strictSchema.parse(fieldSet);

        expect(result[0].field).toBe('name');
        expect(result[0].value).toBe('John Doe');
        expect(result[1].field).toBe('age');
        expect(result[1].value).toBe(30);
        expect(result[2].field).toBe('age');
        expect(result[2].value).toBeNull();
      });
    });

    describe('Complete type schema generation', () => {
      it('should generate correct schemas for a complete type definition', () => {
        const typeDefinition = {
          name: 'User',
          friendlyName: 'User',
          knowledgeTemplate: 'User information',
          fields: [
            { name: 'email', friendlyName: 'Email', type: 'string' as const, required: true },
            { name: 'age', friendlyName: 'Age', type: 'number' as const, required: false },
            { name: 'isAdmin', friendlyName: 'Is Admin', type: 'boolean' as const, required: false },
            { name: 'role', friendlyName: 'Role', type: 'enum' as const, required: false, enumOptions: ['user', 'moderator', 'admin'] },
            { name: 'createdAt', friendlyName: 'Created At', type: 'date' as const, required: true },
          ],
        };

        // Build fields schema
        const fieldsSchema = z.object({
          email: z.string(),
          age: z.number().nullable(),
          isAdmin: z.boolean().nullable(),
          role: z.enum(['user', 'moderator', 'admin']).nullable(),
          createdAt: z.iso.date(),
        }).meta({ title: 'User_fields' });

        const strictFieldsSchema = strictify(fieldsSchema);
        const fieldsJsonSchema = toJSONSchema(strictFieldsSchema, true);

        // All fields should be in required array in strict mode
        expect(fieldsJsonSchema.required).toContain('email');
        expect(fieldsJsonSchema.required).toContain('age');
        expect(fieldsJsonSchema.required).toContain('isAdmin');
        expect(fieldsJsonSchema.required).toContain('role');
        expect(fieldsJsonSchema.required).toContain('createdAt');

        // Nullable fields should have null type
        expect(js(fieldsJsonSchema.properties!.age).type).toContain('null');
        expect(js(fieldsJsonSchema.properties!.isAdmin).type).toContain('null');
        expect(js(fieldsJsonSchema.properties!.role).type).toContain('null');

        // Required fields should not have null type (unless explicitly nullable)
        expect(js(fieldsJsonSchema.properties!.email).type).toBe('string');
      });

      it('should handle field names enum', () => {
        const fieldNamesSchema = z.enum(['name', 'email', 'age', 'active']).meta({ title: 'User_fieldNames' });

        const strictSchema = strictify(fieldNamesSchema);
        const jsonSchema = toJSONSchema(strictSchema, true);

        expect(jsonSchema.enum).toEqual(['name', 'email', 'age', 'active']);
      });
    });

    describe('Edge cases in recursive schemas', () => {
      it('should handle empty where clauses', () => {
        const whereSchema: z.ZodType<any> = z.object({
          get and() {
            return z.array(whereSchema).optional();
          },
          get or() {
            return z.array(whereSchema).optional();
          },
          name: z.object({
            equals: z.string().optional(),
          }).optional(),
        });

        const strictSchema = strictify(whereSchema);

        // Empty object should be valid
        const result1 = strictSchema.parse({});
        expect(result1).toEqual({});

        // Just field condition
        const result2 = strictSchema.parse({ name: { equals: 'test' } });
        expect(result2.name?.equals).toBe('test');

        // Empty and/or arrays
        const result3 = strictSchema.parse({ and: [], or: [] });
        expect(result3.and).toEqual([]);
        expect(result3.or).toEqual([]);
      });

      it('should handle where clauses with only logical operators', () => {
        const whereSchema: z.ZodType<any> = z.object({
          get and() {
            return z.array(whereSchema).optional();
          },
          get or() {
            return z.array(whereSchema).optional();
          },
          get not() {
            return whereSchema.optional();
          },
          status: z.object({
            equals: z.string().optional(),
          }).optional(),
        });

        const strictSchema = strictify(whereSchema);

        const logicalOnly = {
          not: {
            or: [
              { status: { equals: 'deleted' } },
              { status: { equals: 'archived' } },
            ]
          }
        };

        const result = strictSchema.parse(logicalOnly);
        expect(result.not?.or).toBeDefined();
        expect(result.not.or.length).toBe(2);
      });
    });
  });
});
