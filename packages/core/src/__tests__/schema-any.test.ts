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
import { GOOGLE_STRICT, LENIENT, toJSONSchema, JSONSchema } from '../schema';

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

  describe('Google dialect — unconstrained encoding', () => {
    /**
     * Collect every JSON-Schema keyword present anywhere in a schema tree.
     * Used to assert the ABSENCE of a whole class of keyword rather than
     * spot-checking the few positions we happened to think of.
     */
    const keywordsIn = (node: unknown, into = new Set<string>()): Set<string> => {
      if (Array.isArray(node)) {
        for (const item of node) keywordsIn(item, into);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          into.add(k);
          keywordsIn(v, into);
        }
      }
      return into;
    };

    const FORBIDDEN_BY_GOOGLE = ['anyOf', 'oneOf', 'allOf', '$defs', '$ref'];

    test('a bare z.any() is the empty schema — no keyword at all', () => {
      const js = toJSONSchema(z.any(), GOOGLE_STRICT);
      expect(js).toEqual({});
    });

    test('z.unknown() encodes identically to z.any()', () => {
      expect(toJSONSchema(z.unknown(), GOOGLE_STRICT)).toEqual(toJSONSchema(z.any(), GOOGLE_STRICT));
    });

    test('a described z.any() keeps its description — the model still gets the prose', () => {
      // The empty schema carries no assertion, so the description is the only
      // signal left about what belongs there. Losing it would be a silent
      // downgrade of every open-value argument on Gemini.
      const js = toJSONSchema(z.any().describe('Arbitrary JSON value'), GOOGLE_STRICT);
      expect(js).toEqual({ description: 'Arbitrary JSON value' });
    });

    test('ONE shared z.any() instance used many times never becomes a $ref', () => {
      // A codegen layer that hands out a single "any" node would otherwise hit
      // the definition cache on the second use and emit `$ref: '#/$defs/…'`,
      // resurrecting the exact keyword the encoding exists to avoid.
      const shared = z.any();
      const js = toJSONSchema(
        z.object({ a: shared, b: shared, c: z.array(shared) }),
        GOOGLE_STRICT,
      );
      expect(js.$defs).toBeUndefined();
      const props = js.properties as Record<string, JSONSchema>;
      expect(props.a).toEqual({});
      expect(props.b).toEqual({});
      expect((props.c.items as JSONSchema)).toEqual({});
    });

    test("a z.any() tagged with meta({id}) is still inlined, not promoted to $defs", () => {
      const js = toJSONSchema(
        z.object({ a: z.any().meta({ id: 'AnyValue' }), b: z.string() }),
        GOOGLE_STRICT,
      );
      expect(js.$defs).toBeUndefined();
      expect(keywordsIn(js).has('$ref')).toBe(false);
    });

    test('REGRESSION: the api_signature tool schema compiles Google-safely', () => {
      // The exact shape captured from the wire request that produced a 100%
      // reproducible `400 INVALID_ARGUMENT` from Google, via OpenRouter, on
      // `google/gemini-3-flash-preview` with a forced tool call: an open
      // TypeDef — a named object that also accepts arbitrary extra JSON
      // values. Before the fix this emitted
      //   additionalProperties: { $ref: '#/$defs/Any' }
      // plus a self-referencing `$defs/Any` built out of `anyOf`, i.e. both
      // keyword families GOOGLE_STRICT declares forbidden.
      const apiSignature = z.object({
        signature: z.object({ name: z.string() })
          .catchall(z.any())
          .describe('The signature of the API function being declared.'),
      });

      const js = toJSONSchema(apiSignature, GOOGLE_STRICT);
      const keywords = keywordsIn(js);
      for (const forbidden of FORBIDDEN_BY_GOOGLE) {
        expect([forbidden, keywords.has(forbidden)]).toEqual([forbidden, false]);
      }

      // The useful structure survives: the named field is still declared and
      // still required, and the open tail still accepts any JSON value.
      const signature = (js.properties as Record<string, JSONSchema>).signature;
      expect(signature.type).toBe('object');
      expect((signature.properties as Record<string, JSONSchema>).name.type).toBe('string');
      expect(signature.required).toEqual(['name']);
      expect(signature.additionalProperties).toEqual({});
      expect(signature.description).toBe('The signature of the API function being declared.');
    });

    test('REGRESSION: the same schema under LENIENT still shows the shape Google rejected', () => {
      // Guards the diagnosis, not just the fix: if this ever stops emitting
      // `anyOf` + `$defs/Any`, the Google assertions above have stopped
      // proving anything.
      const apiSignature = z.object({
        signature: z.object({ name: z.string() }).catchall(z.any()),
      });
      const keywords = keywordsIn(toJSONSchema(apiSignature, LENIENT));
      expect(keywords.has('anyOf')).toBe(true);
      expect(keywords.has('$defs')).toBe(true);
      expect(keywords.has('$ref')).toBe(true);
    });
  });
});
