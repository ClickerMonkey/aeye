/**
 * toJSONSchema — `z.any()` / `z.unknown()` handling.
 *
 * Under OpenAI's strict structured-output mode every node needs a
 * `type` key; bare `{}` (the old output for `z.any()`) gets rejected.
 * The fix promotes every `z.any()` / `z.unknown()` to a shared
 * `$defs/Any` definition and emits `$ref` at each call site, keeping
 * strict-mode valid AND compact when `any` appears in many positions.
 */

import z from 'zod';
import { toJSONSchema, JSONSchema } from '../schema';

describe('toJSONSchema — z.any() / z.unknown()', () => {
  describe('basic promotion', () => {
    test('z.any() alone returns a $ref to $defs/Any', () => {
      const js = toJSONSchema(z.any(), { strict: true });
      expect(js.$ref).toBe('#/$defs/Any');
      expect(js.$defs).toBeDefined();
      expect(js.$defs!.Any).toBeDefined();
      expect(js.$defs!.Any.anyOf).toBeDefined();
    });

    test('z.unknown() produces an identical $ref — same $defs entry', () => {
      const any = toJSONSchema(z.any(), { strict: true });
      const unknown = toJSONSchema(z.unknown(), { strict: true });
      expect(unknown.$ref).toBe(any.$ref);
      expect(unknown.$defs!.Any).toEqual(any.$defs!.Any);
    });
  });

  describe('no schema explosion', () => {
    test('many z.any() sites share a single $defs/Any', () => {
      const schema = z.object({
        a: z.any(),
        b: z.any(),
        c: z.array(z.any()),
        d: z.object({ nested: z.any() }),
      });
      const js = toJSONSchema(schema, { strict: true });
      expect(js.$defs).toBeDefined();
      expect(Object.keys(js.$defs!)).toContain('Any');
      const props = js.properties as Record<string, JSONSchema>;
      expect(props.a.$ref).toBe('#/$defs/Any');
      expect(props.b.$ref).toBe('#/$defs/Any');
      expect((props.c.items as JSONSchema).$ref).toBe('#/$defs/Any');
      const nested = props.d.properties as Record<string, JSONSchema>;
      expect(nested.nested.$ref).toBe('#/$defs/Any');
    });
  });

  describe('strict mode shape', () => {
    test('$defs/Any covers primitives, array-of-any, and array-of-{key,value}', () => {
      const js = toJSONSchema(z.any(), { strict: true });
      const any = js.$defs!.Any;
      expect(Array.isArray(any.anyOf)).toBe(true);

      const branches = any.anyOf as JSONSchema[];
      const types = branches.map((b) => b.type);
      expect(types).toContain('string');
      expect(types).toContain('number');
      expect(types).toContain('boolean');
      expect(types).toContain('null');

      const arrays = branches.filter((b) => b.type === 'array');
      expect(arrays.length).toBe(2);

      const arrayOfAny = arrays.find((a) => (a.items as JSONSchema).$ref === '#/$defs/Any');
      expect(arrayOfAny).toBeDefined();

      const arrayOfPairs = arrays.find((a) => {
        const items = a.items as JSONSchema;
        return items.type === 'object'
          && items.properties?.key !== undefined
          && items.properties?.value !== undefined;
      });
      expect(arrayOfPairs).toBeDefined();
      const pairItems = arrayOfPairs!.items as JSONSchema;
      expect(pairItems.required).toEqual(['key', 'value']);
      expect(pairItems.additionalProperties).toBe(false);
      const valueSchema = (pairItems.properties as Record<string, JSONSchema>).value;
      expect(valueSchema.$ref).toBe('#/$defs/Any');
    });

    test('strict mode emits NO open-ended object branch', () => {
      const js = toJSONSchema(z.any(), { strict: true });
      const branches = js.$defs!.Any.anyOf as JSONSchema[];
      const openObjects = branches.filter(
        (b) => b.type === 'object' && b.additionalProperties !== false,
      );
      expect(openObjects).toEqual([]);
    });

    test('every schema-shaped node carries a `type` (or $ref) — OpenAI compliance gate', () => {
      const js = toJSONSchema(z.any(), { strict: true });

      // Top-level anyOf branches must each declare `type` or `$ref`.
      const branches = js.$defs!.Any.anyOf as JSONSchema[];
      for (const b of branches) {
        expect(b.type !== undefined || b.$ref !== undefined).toBe(true);
      }

      // Drill into the array-of-pairs branch — its `items` is an object
      // schema, and `items.properties.{key,value}` are nested schemas.
      // All of those must also declare `type` / `$ref`.
      const arrayOfPairs = branches.find(
        (b) => b.type === 'array'
          && (b.items as JSONSchema)?.type === 'object',
      );
      expect(arrayOfPairs).toBeDefined();
      const items = arrayOfPairs!.items as JSONSchema;
      expect(items.type).toBe('object');
      const props = items.properties as Record<string, JSONSchema>;
      expect(props.key.type).toBe('string');
      expect(props.value.$ref).toBe('#/$defs/Any');
    });
  });

  describe('non-strict mode shape', () => {
    test('emits open-record branch instead of array-of-pairs', () => {
      const js = toJSONSchema(z.any(), { strict: false });
      const branches = js.$defs!.Any.anyOf as JSONSchema[];

      expect(branches.map((b) => b.type)).toEqual(
        expect.arrayContaining(['string', 'number', 'boolean', 'null']),
      );

      const arrays = branches.filter((b) => b.type === 'array');
      expect(arrays.length).toBe(1);

      const openObj = branches.find((b) => b.type === 'object');
      expect(openObj).toBeDefined();
      expect((openObj!.additionalProperties as JSONSchema).$ref).toBe('#/$defs/Any');
    });
  });

  describe('integration with composites', () => {
    test('z.array(z.any()) — outer array carries items: $ref', () => {
      const js = toJSONSchema(z.array(z.any()), { strict: true });
      expect(js.type).toBe('array');
      expect((js.items as JSONSchema).$ref).toBe('#/$defs/Any');
      expect(js.$defs!.Any).toBeDefined();
    });

    test('z.object({a: z.any()}) — property slot is $ref', () => {
      const js = toJSONSchema(z.object({ a: z.any() }), { strict: true });
      const props = js.properties as Record<string, JSONSchema>;
      expect(props.a.$ref).toBe('#/$defs/Any');
    });
  });
});
