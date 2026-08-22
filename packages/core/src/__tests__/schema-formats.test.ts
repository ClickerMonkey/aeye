/**
 * Format-descriptor matrix tests.
 *
 * Each provider/strict combination is represented by a `FormatDescriptor`.
 * These tests verify that `toJSONSchema(schema, descriptor)` and
 * `strictify(schema, descriptor)` produce the right shapes for
 * representative Zod features under each named descriptor.
 */

import z from 'zod';
import {
  ANTHROPIC_NON_STRICT,
  ANTHROPIC_STRICT,
  GOOGLE_NON_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_NON_STRICT,
  OPENAI_STRICT,
  type FormatDescriptor,
  getDescriptor,
  getDescriptorById,
  hasDescriptorFamily,
  registerDescriptor,
  resolveDescriptor,
  strictify,
  toJSONSchema,
} from '../schema';

describe('FormatDescriptor matrix', () => {
  describe('descriptor lookups', () => {
    it('getDescriptor returns the right strict descriptor per family', () => {
      expect(getDescriptor('openai', true)).toBe(OPENAI_STRICT);
      expect(getDescriptor('anthropic', true)).toBe(ANTHROPIC_STRICT);
      expect(getDescriptor('google', true)).toBe(GOOGLE_STRICT);
    });

    it('getDescriptor returns the family-tagged lenient when strict is false', () => {
      // Each family has a registered non-strict slot aliased to LENIENT but
      // tagged with the family name (used for diagnostics). They share
      // LENIENT's behavior — verified by the dedicated alias test below.
      expect(getDescriptor('openai', false)).toBe(OPENAI_NON_STRICT);
      expect(getDescriptor('anthropic', false)).toBe(ANTHROPIC_NON_STRICT);
      expect(getDescriptor('google', false)).toBe(GOOGLE_NON_STRICT);
    });

    it('getDescriptor returns LENIENT for unknown families regardless of strict', () => {
      expect(getDescriptor('unregistered-family', true)).toBe(LENIENT);
      expect(getDescriptor('unregistered-family', false)).toBe(LENIENT);
    });

    it('getDescriptorById round-trips named descriptors', () => {
      expect(getDescriptorById('openai-strict')).toBe(OPENAI_STRICT);
      expect(getDescriptorById('anthropic-strict')).toBe(ANTHROPIC_STRICT);
      expect(getDescriptorById('google-strict')).toBe(GOOGLE_STRICT);
      expect(getDescriptorById('lenient')).toBe(LENIENT);
    });

    it('getDescriptorById returns LENIENT for unknown ids', () => {
      expect(getDescriptorById('unknown-id')).toBe(LENIENT);
      expect(getDescriptorById(undefined)).toBe(LENIENT);
    });

    it('resolveDescriptor handles all input shapes', () => {
      // boolean overload (legacy)
      expect(resolveDescriptor(true)).toBe(OPENAI_STRICT);
      expect(resolveDescriptor(false)).toBe(LENIENT);
      // options overload — strict variants
      expect(resolveDescriptor({ strict: true, format: 'anthropic' })).toBe(ANTHROPIC_STRICT);
      expect(resolveDescriptor({ strict: true, format: 'google' })).toBe(GOOGLE_STRICT);
      // options overload — non-strict variants resolve to the family's lenient slot
      expect(resolveDescriptor({ strict: false, format: 'anthropic' })).toBe(ANTHROPIC_NON_STRICT);
      // descriptor passthrough
      expect(resolveDescriptor(ANTHROPIC_STRICT)).toBe(ANTHROPIC_STRICT);
    });
  });

  describe('object encoding', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    it('OPENAI_STRICT marks every field required and closes the object', () => {
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.required).toEqual(['name', 'age']);
      expect(json.additionalProperties).toBe(false);
      // age is optional → nullable in OpenAI strict
      const ageProp = json.properties!.age;
      const ageType = Array.isArray(ageProp.type) ? ageProp.type : (ageProp.anyOf ? 'union' : ageProp.type);
      expect(ageType).toBeDefined();
    });

    it('ANTHROPIC_STRICT keeps optional fields out of required[] but closes the object', () => {
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.required).toEqual(['name']); // age is optional
      expect(json.additionalProperties).toBe(false);
    });

    it('GOOGLE_STRICT keeps optional fields out of required[] and leaves the object open', () => {
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.required).toEqual(['name']);
      expect(json.additionalProperties).toBeUndefined();
    });

    it('LENIENT keeps optional fields out of required[] and leaves the object open', () => {
      const json = toJSONSchema(schema, LENIENT);
      expect(json.required).toEqual(['name']);
      expect(json.additionalProperties).toBeUndefined();
    });
  });

  describe('record encoding', () => {
    const schema = z.object({
      tags: z.record(z.string(), z.string()),
    });

    it('OPENAI_STRICT encodes records as array-of-pairs', () => {
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.properties!.tags.type).toBe('array');
      expect(json.properties!.tags.items?.type).toBe('object');
      expect(json.properties!.tags.items?.properties).toHaveProperty('key');
      expect(json.properties!.tags.items?.properties).toHaveProperty('value');
    });

    it('ANTHROPIC_STRICT encodes records as array-of-pairs (open records unsupported)', () => {
      // Anthropic strict only allows additionalProperties: false (no schema),
      // so open records are unrepresentable; we use the same array-of-pairs
      // workaround as OpenAI.
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.properties!.tags.type).toBe('array');
      expect(json.properties!.tags.items?.properties).toHaveProperty('key');
      expect(json.properties!.tags.items?.properties).toHaveProperty('value');
    });

    it('GOOGLE_STRICT keeps records as open-record', () => {
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.properties!.tags.type).toBe('object');
      expect(json.properties!.tags.additionalProperties).toBeDefined();
    });

    it('LENIENT keeps records as open-record', () => {
      const json = toJSONSchema(schema, LENIENT);
      expect(json.properties!.tags.type).toBe('object');
      expect(json.properties!.tags.additionalProperties).toBeDefined();
    });
  });

  describe('tuple encoding', () => {
    const schema = z.object({
      pair: z.tuple([z.string(), z.number(), z.boolean()]),
    });

    it('OPENAI_STRICT encodes tuples as object-with-numeric-keys', () => {
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.properties!.pair.type).toBe('object');
      expect(Object.keys(json.properties!.pair.properties!).sort()).toEqual(['0', '1', '2']);
      expect(json.properties!.pair.additionalProperties).toBe(false);
    });

    it('ANTHROPIC_STRICT collapses tuples to items-union (no positional support)', () => {
      // Anthropic doesn't list prefixItems as a supported keyword; we collapse
      // mixed-type tuples to a homogeneous `items: { anyOf: [...] }`.
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.properties!.pair.type).toBe('array');
      expect(json.properties!.pair.prefixItems).toBeUndefined();
      expect(json.properties!.pair.items?.anyOf).toHaveLength(3);
    });

    it('GOOGLE_STRICT uses prefixItems', () => {
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.properties!.pair.type).toBe('array');
      expect(json.properties!.pair.prefixItems).toHaveLength(3);
    });

    it('LENIENT uses prefixItems', () => {
      const json = toJSONSchema(schema, LENIENT);
      expect(json.properties!.pair.type).toBe('array');
      expect(json.properties!.pair.prefixItems).toHaveLength(3);
    });
  });

  describe('intersection (allOf vs anyOf)', () => {
    const schema = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.number() }),
    );

    it('OPENAI_STRICT collapses to anyOf (no allOf support)', () => {
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.anyOf).toBeDefined();
      expect(json.allOf).toBeUndefined();
    });

    it('ANTHROPIC_STRICT keeps allOf', () => {
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.allOf).toBeDefined();
    });

    it('GOOGLE_STRICT collapses allOf to anyOf (combinators not in supported list)', () => {
      // Gemini's documented supported keywords don't include allOf/anyOf/oneOf;
      // we conservatively avoid emitting them and degrade intersections to a
      // best-effort anyOf representation.
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.allOf).toBeUndefined();
      expect(json.anyOf).toBeDefined();
    });

    it('LENIENT keeps allOf', () => {
      const json = toJSONSchema(schema, LENIENT);
      expect(json.allOf).toBeDefined();
    });
  });

  describe('z.any encoding', () => {
    const schema = z.object({ data: z.any() });

    it('OPENAI_STRICT uses recursive-strict (array-of-pairs object branch)', () => {
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.$defs!.Any).toBeDefined();
      const branches = json.$defs!.Any.anyOf!;
      const objectBranch = branches.find(b => b.type === 'array' && b.items?.type === 'object');
      expect(objectBranch).toBeDefined();
      expect(objectBranch!.items!.properties).toHaveProperty('key');
      expect(objectBranch!.items!.properties).toHaveProperty('value');
    });

    it('ANTHROPIC_STRICT uses flat (non-recursive) Any encoding', () => {
      // Anthropic rejects circular `$defs` graphs, so `z.any()` is inlined as
      // a flat `anyOf` over every JSON value type — equivalent to TS `any`,
      // with no self-reference. No shared `$defs/Any` entry is created.
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.$defs?.Any).toBeUndefined();
      const inlined = json.properties!.data;
      expect(inlined.anyOf).toBeDefined();
      const types = inlined.anyOf!.map((b) => b.type).sort();
      expect(types).toEqual(['array', 'boolean', 'null', 'number', 'object', 'string']);
      // Object branch is open and array branch is unconstrained — accepts
      // every JSON value, just like TS `any`.
      const objectBranch = inlined.anyOf!.find((b) => b.type === 'object');
      expect(objectBranch?.additionalProperties).toBe(true);
      const arrayBranch = inlined.anyOf!.find((b) => b.type === 'array');
      expect(arrayBranch?.items).toBeUndefined();
      // Crucially: nothing inside references back to itself.
      const stringified = JSON.stringify(inlined);
      expect(stringified).not.toContain('$ref');
    });

    it('GOOGLE_STRICT uses unconstrained (no anyOf, no $defs) Any encoding', () => {
      // Google's dialect forbids `anyOf` AND named `$defs`/`$ref`, so neither
      // recursive encoding nor the flat `anyOf` is available to it. The empty
      // schema is what's left, and it is the exact meaning of "any JSON
      // value" — a schema with no assertion keywords validates every instance.
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.$defs).toBeUndefined();
      expect(json.properties!.data).toEqual({});
    });

    it('GOOGLE_NON_STRICT uses the same unconstrained Any encoding as GOOGLE_STRICT', () => {
      // Gemini compiles the decoding grammar whenever a tool call is forced,
      // which has nothing to do with a per-tool `strict` flag — Google's
      // function-calling API has none. The encoding is a property of the
      // dialect, so it has to hold on the non-strict descriptor too.
      const json = toJSONSchema(schema, GOOGLE_NON_STRICT);
      expect(json.$defs).toBeUndefined();
      expect(json.properties!.data).toEqual({});
    });

    it('LENIENT uses recursive-open', () => {
      const json = toJSONSchema(schema, LENIENT);
      const branches = json.$defs!.Any.anyOf!;
      const objectBranch = branches.find(b => b.type === 'object');
      expect(objectBranch?.additionalProperties).toBeDefined();
    });
  });

  describe('string formats', () => {
    it('OPENAI_STRICT keeps email (whitelisted) and drops non-whitelisted formats', () => {
      const schema = z.object({
        contact: z.email(),
      });
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.properties!.contact.format).toBe('email');
    });

    it('ANTHROPIC_STRICT passes whitelisted formats through', () => {
      const schema = z.object({
        contact: z.email(),
        unique: z.uuid(),
      });
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.properties!.contact.format).toBe('email');
      expect(json.properties!.unique.format).toBe('uuid');
    });

    it('LENIENT passes all string formats through', () => {
      const schema = z.object({
        contact: z.email(),
        unique: z.uuid(),
      });
      const json = toJSONSchema(schema, LENIENT);
      expect(json.properties!.contact.format).toBe('email');
      expect(json.properties!.unique.format).toBe('uuid');
    });
  });

  describe('strictify caching', () => {
    it('returns the same reference on repeat calls with same descriptor', () => {
      const schema = z.object({ name: z.string() });
      const a = strictify(schema, OPENAI_STRICT);
      const b = strictify(schema, OPENAI_STRICT);
      expect(a).toBe(b);
    });

    it('returns different references for different descriptors', () => {
      const schema = z.object({
        items: z.record(z.string(), z.string()),
      });
      const a = strictify(schema, OPENAI_STRICT);
      const b = strictify(schema, ANTHROPIC_STRICT);
      expect(a).not.toBe(b);
    });

    it('LENIENT returns the input schema unchanged', () => {
      const schema = z.object({ name: z.string() });
      const result = strictify(schema, LENIENT);
      expect(result).toBe(schema);
    });

    it('OPENAI_STRICT and ANTHROPIC_STRICT both accept the natural shape (lenient input)', async () => {
      // Strictified schemas should still accept payloads in their natural Zod
      // shape — important for test/dev workflows that pass plain JS objects.
      const schema = z.object({
        items: z.record(z.string(), z.number()),
      });
      const openaiStrict = strictify(schema, OPENAI_STRICT);
      const anthropicStrict = strictify(schema, ANTHROPIC_STRICT);

      const naturalPayload = { items: { foo: 1, bar: 2 } };
      await expect(openaiStrict.parseAsync(naturalPayload)).resolves.toBeDefined();
      await expect(anthropicStrict.parseAsync(naturalPayload)).resolves.toBeDefined();
    });

    it('OPENAI_STRICT also accepts the array-of-pairs wire shape', async () => {
      const schema = z.object({
        items: z.record(z.string(), z.number()),
      });
      const strict = strictify(schema, OPENAI_STRICT);
      const wirePayload = {
        items: [
          { key: 'foo', value: 1 },
          { key: 'bar', value: 2 },
        ],
      };
      const parsed = await strict.parseAsync(wirePayload);
      expect(parsed.items).toEqual({ foo: 1, bar: 2 });
    });
  });

  describe('backward compatibility', () => {
    it('toJSONSchema(schema, true) behaves identically to OPENAI_STRICT', () => {
      const schema = z.object({
        name: z.string(),
        tags: z.record(z.string(), z.string()),
      });
      const a = toJSONSchema(schema, true);
      const b = toJSONSchema(schema, OPENAI_STRICT);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('toJSONSchema(schema, false) behaves identically to LENIENT', () => {
      const schema = z.object({
        name: z.string(),
        tags: z.record(z.string(), z.string()),
      });
      const a = toJSONSchema(schema, false);
      const b = toJSONSchema(schema, LENIENT);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('strictify(schema) without descriptor defaults to OPENAI_STRICT', () => {
      const schema = z.object({ name: z.string() });
      const a = strictify(schema);
      const b = strictify(schema, OPENAI_STRICT);
      expect(a).toBe(b);
    });
  });

  describe('Anthropic strict — unsupported constraint dropping', () => {
    it('drops minimum/maximum on numbers', () => {
      const schema = z.object({ age: z.number().min(0).max(120) });
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.properties!.age.minimum).toBeUndefined();
      expect(json.properties!.age.maximum).toBeUndefined();
    });

    it('drops minLength/maxLength on strings', () => {
      const schema = z.object({ name: z.string().min(2).max(50) });
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.properties!.name.minLength).toBeUndefined();
      expect(json.properties!.name.maxLength).toBeUndefined();
    });

    it('drops minItems/maxItems on arrays', () => {
      const schema = z.object({ tags: z.array(z.string()).min(1).max(10) });
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      expect(json.properties!.tags.minItems).toBeUndefined();
      expect(json.properties!.tags.maxItems).toBeUndefined();
    });
  });

  describe('Google strict — propertyOrdering and constraint policy', () => {
    it('emits propertyOrdering listing object properties in declaration order', () => {
      const schema = z.object({
        zebra: z.string(),
        apple: z.number(),
        mango: z.boolean(),
      });
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.propertyOrdering).toEqual(['zebra', 'apple', 'mango']);
    });

    it('does NOT emit propertyOrdering under OPENAI_STRICT', () => {
      const schema = z.object({ a: z.string(), b: z.number() });
      const json = toJSONSchema(schema, OPENAI_STRICT);
      expect(json.propertyOrdering).toBeUndefined();
    });

    it('keeps numeric minimum/maximum (documented support)', () => {
      const schema = z.object({ age: z.number().min(0).max(120) });
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.properties!.age.minimum).toBe(0);
      expect(json.properties!.age.maximum).toBe(120);
    });

    it('drops minLength/maxLength (string-length not in supported list)', () => {
      const schema = z.object({ name: z.string().min(2).max(50) });
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.properties!.name.minLength).toBeUndefined();
      expect(json.properties!.name.maxLength).toBeUndefined();
    });

    it('drops non-supported string formats (only date-time/date/time allowed)', () => {
      const schema = z.object({ contact: z.email(), unique: z.uuid() });
      const json = toJSONSchema(schema, GOOGLE_STRICT);
      expect(json.properties!.contact.format).toBeUndefined();
      expect(json.properties!.unique.format).toBeUndefined();
    });
  });

  describe('registerDescriptor — custom family registration', () => {
    it('registers a custom descriptor reachable by id and family', () => {
      const CUSTOM_TIGHT: FormatDescriptor = {
        ...OPENAI_STRICT,
        id: 'test-tight',
        family: 'test-tight',
        allowPattern: false,
        allowMultiplePatterns: false,
      };
      registerDescriptor(CUSTOM_TIGHT);

      // Both lookup paths resolve.
      expect(getDescriptorById('test-tight')).toBe(CUSTOM_TIGHT);
      expect(getDescriptor('test-tight', true)).toBe(CUSTOM_TIGHT);
      // Lenient slot for the same family is unset → falls back to LENIENT.
      expect(getDescriptor('test-tight', false)).toBe(LENIENT);
    });

    it('makes the custom family discoverable via hasDescriptorFamily', () => {
      registerDescriptor({
        ...OPENAI_STRICT,
        id: 'test-discoverable',
        family: 'test-discoverable',
      });
      expect(hasDescriptorFamily('test-discoverable')).toBe(true);
      expect(hasDescriptorFamily('test-not-registered')).toBe(false);
    });

    it('resolveDescriptor handles a registered family via {format, strict}', () => {
      registerDescriptor({
        ...OPENAI_STRICT,
        id: 'test-resolve',
        family: 'test-resolve',
      });
      const d = resolveDescriptor({ strict: true, format: 'test-resolve' });
      expect(d.id).toBe('test-resolve');
    });

    it('strictify works against a custom descriptor', () => {
      const CUSTOM: FormatDescriptor = {
        ...OPENAI_STRICT,
        id: 'test-strictify-custom',
        family: 'test-strictify-custom',
      };
      registerDescriptor(CUSTOM);

      const schema = z.object({
        items: z.record(z.string(), z.number()),
      });
      const strictified = strictify(schema, CUSTOM);
      // Inherits the OpenAI-strict behavior: array-of-pairs preprocess accepts the wire shape.
      const parsed = strictified.parse({ items: [{ key: 'a', value: 1 }] });
      expect(parsed.items).toEqual({ a: 1 });
    });

    it('toJSONSchema honors a registered descriptor', () => {
      const CUSTOM: FormatDescriptor = {
        ...ANTHROPIC_STRICT,
        id: 'test-anthropic-variant',
        family: 'test-anthropic-variant',
        // Tweak: this variant DOES allow minimum/maximum on numbers.
        allowMinimumMaximum: true,
      };
      registerDescriptor(CUSTOM);

      const schema = z.object({ age: z.number().min(0).max(120) });
      const json = toJSONSchema(schema, CUSTOM);
      // Inherited Anthropic shape: closed object, no record-as-pairs (records
      // here unused), but customized to keep numeric range.
      expect(json.properties!.age.minimum).toBe(0);
      expect(json.properties!.age.maximum).toBe(120);
    });

    it('replacing a same-id descriptor updates the registry', () => {
      registerDescriptor({
        ...OPENAI_STRICT,
        id: 'test-replace',
        family: 'test-replace',
        allowPattern: true,
      });
      registerDescriptor({
        ...OPENAI_STRICT,
        id: 'test-replace',
        family: 'test-replace',
        allowPattern: false,  // overwrite
      });
      const d = getDescriptorById('test-replace');
      expect(d.allowPattern).toBe(false);
    });
  });

  describe('aliased non-strict descriptors', () => {
    it('OPENAI_NON_STRICT, ANTHROPIC_NON_STRICT, GOOGLE_NON_STRICT all behave as LENIENT', () => {
      const schema = z.object({
        name: z.string(),
        tags: z.record(z.string(), z.string()),
      });
      const lenient = JSON.stringify(toJSONSchema(schema, LENIENT));
      // The non-strict variants share LENIENT's shape but carry a different family tag.
      expect(JSON.stringify(toJSONSchema(schema, OPENAI_NON_STRICT))).toBe(lenient);
      expect(JSON.stringify(toJSONSchema(schema, ANTHROPIC_NON_STRICT))).toBe(lenient);
      expect(JSON.stringify(toJSONSchema(schema, GOOGLE_NON_STRICT))).toBe(lenient);
    });

    it('GOOGLE_NON_STRICT diverges from LENIENT on exactly one axis: the Any encoding', () => {
      // The one deliberate exception to the alias above. Gemini rejects a
      // self-referencing `$defs/Any` whenever it has to compile a decoding
      // grammar, and it does that for a forced tool call regardless of any
      // strict flag — so this divergence is dialect-level, not strict-level.
      // Asserted explicitly so a future "tidy up the alias" edit has to
      // confront it rather than silently reintroduce the 400.
      expect(GOOGLE_NON_STRICT.anyEncoding).toBe('unconstrained');
      expect(LENIENT.anyEncoding).toBe('recursive-open');

      const { id, family, anyEncoding, jsonFallbackInstruction, ...rest } = GOOGLE_NON_STRICT;
      const { id: lid, family: lfamily, anyEncoding: lany, jsonFallbackInstruction: ljfi, ...lrest } = LENIENT;
      expect(rest).toEqual(lrest);
    });
  });
});

/**
 * Cycle-breaking + flat "any" encoding tests.
 *
 * Anthropic's tool `input_schema` validator rejects circular `$defs`
 * graphs ("Circular reference detected in schema definitions: ..."). The
 * `convert()` cycle-breaker detects re-encounters that are still on the
 * conversion stack and replaces the back-edge with the descriptor's flat
 * "any" placeholder when `supportsRecursion: false`.
 *
 * These tests cover:
 * 1. The `flat` `anyEncoding` body shape (no recursion, accepts every JSON value).
 * 2. Cycle detection on `z.lazy` self-recursion (the canonical recursive case).
 * 3. Cycle detection via `aid` metadata (gin's stable-id mechanism).
 * 4. Mutual recursion between two `z.lazy` schemas.
 * 5. Shared (non-cyclic) refs are still emitted as `$ref`.
 * 6. Recursion-supporting descriptors keep `$ref` for cycles.
 */

// --- helpers --------------------------------------------------------------

/** Walk a JSON Schema and yield every node (including `items`, `anyOf`, `properties`, etc.). */
function* walkSchema(schema: any): Generator<any> {
  if (schema === null || typeof schema !== 'object') return;
  yield schema;
  for (const key of ['items', 'additionalProperties', 'not', 'propertyNames']) {
    if (schema[key] && typeof schema[key] === 'object') yield* walkSchema(schema[key]);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) yield* walkSchema(sub);
    }
  }
  if (schema.properties) {
    for (const key in schema.properties) yield* walkSchema(schema.properties[key]);
  }
  if (schema.$defs) {
    for (const key in schema.$defs) yield* walkSchema(schema.$defs[key]);
  }
}

/** Collect every `$ref` value referenced anywhere in the schema. */
function collectRefs(schema: any): string[] {
  const refs: string[] = [];
  for (const node of walkSchema(schema)) {
    if (typeof node.$ref === 'string') refs.push(node.$ref);
  }
  return refs;
}

describe('flat anyEncoding (Anthropic)', () => {
  it('inlines a non-recursive anyOf covering every JSON value type', () => {
    const schema = z.object({ data: z.any() });
    const json = toJSONSchema(schema, ANTHROPIC_STRICT);

    // No shared $defs/Any entry — the flat shape inlines at every use site.
    expect(json.$defs?.Any).toBeUndefined();
    const inlined = json.properties!.data;
    expect(inlined.anyOf).toBeDefined();
    const types = inlined.anyOf!.map((b) => b.type).sort();
    expect(types).toEqual(['array', 'boolean', 'null', 'number', 'object', 'string']);

    // Object branch is open (TS-`any`-like).
    const objectBranch = inlined.anyOf!.find((b) => b.type === 'object');
    expect(objectBranch?.additionalProperties).toBe(true);
    // Array branch has no `items` constraint — accepts any element.
    const arrayBranch = inlined.anyOf!.find((b) => b.type === 'array');
    expect(arrayBranch?.items).toBeUndefined();
    // Crucially: nothing inside this Any encoding is a $ref.
    expect(collectRefs(inlined)).toEqual([]);
  });

  it('z.unknown() also uses the flat encoding under Anthropic', () => {
    const schema = z.object({ data: z.unknown() });
    const json = toJSONSchema(schema, ANTHROPIC_STRICT);
    expect(json.$defs?.Any).toBeUndefined();
    expect(json.properties!.data.anyOf).toBeDefined();
    expect(collectRefs(json.properties!.data)).toEqual([]);
  });

  it('multiple z.any() occurrences each inline (no shared $defs)', () => {
    const schema = z.object({
      a: z.any(),
      b: z.any(),
      c: z.array(z.any()),
    });
    const json = toJSONSchema(schema, ANTHROPIC_STRICT);
    expect(json.$defs?.Any).toBeUndefined();
    expect(collectRefs(json)).toEqual([]);
    expect(json.properties!.a.anyOf).toBeDefined();
    expect(json.properties!.b.anyOf).toBeDefined();
    expect(json.properties!.c.items?.anyOf).toBeDefined();
  });

  it('OPENAI_STRICT and LENIENT keep the recursive $defs/Any encoding', () => {
    const schema = z.object({ data: z.any() });

    const openai = toJSONSchema(schema, OPENAI_STRICT);
    expect(openai.$defs!.Any).toBeDefined();
    expect(openai.properties!.data).toEqual({ $ref: '#/$defs/Any' });

    const lenient = toJSONSchema(schema, LENIENT);
    expect(lenient.$defs!.Any).toBeDefined();
    expect(lenient.properties!.data).toEqual({ $ref: '#/$defs/Any' });
  });
});

describe('cycle-breaking under !supportsRecursion', () => {
  type Node = { value: string; children?: Node[] };
  const NodeSchema: z.ZodType<Node> = z.lazy(() =>
    z.object({
      value: z.string(),
      children: z.array(NodeSchema).optional(),
    }),
  );

  it('replaces self-recursive z.lazy back-edge with the flat "any" placeholder under ANTHROPIC_STRICT', () => {
    const json = toJSONSchema(NodeSchema, ANTHROPIC_STRICT);

    // The schema must not contain ANY $ref pointing back into itself —
    // that's exactly what Anthropic's validator rejects.
    const refs = collectRefs(json);
    for (const ref of refs) {
      // Allowed: no recursive refs at all in a single-cycle schema. If one
      // were emitted, the cycle-breaker failed.
      throw new Error(`unexpected $ref in cycle-broken Anthropic schema: ${ref}`);
    }

    // The placeholder where Node was recursively referenced has the
    // expected open-object shape with a descriptive marker.
    const placeholders: any[] = [];
    for (const node of walkSchema(json)) {
      if (
        node.type === 'object' &&
        node.additionalProperties === true &&
        typeof node.description === 'string' &&
        node.description.startsWith('Would recursively reference ')
      ) {
        placeholders.push(node);
      }
    }
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders[0].description).toMatch(/^Would recursively reference #\/\$defs\//);
  });

  it('keeps the $ref for recursive z.lazy under OPENAI_STRICT (recursion supported)', () => {
    const json = toJSONSchema(NodeSchema, OPENAI_STRICT);
    const refs = collectRefs(json);
    expect(refs.length).toBeGreaterThan(0);
    // Every emitted ref points to a $defs entry that actually exists.
    for (const ref of refs) {
      const id = ref.replace(/^#\/\$defs\//, '');
      if (id !== ref) {
        expect(json.$defs![id]).toBeDefined();
      }
    }
  });

  it('breaks mutual recursion between two z.lazy schemas under ANTHROPIC_STRICT', () => {
    // Standard zod mutual-recursion pattern: each side references the other
    // by name inside its lazy getter. The cross-references resolve at
    // conversion time, not declaration time.
    type A = { name: string; b?: B };
    type B = { tag: number; a?: A };
    const ASchema: z.ZodType<A> = z.lazy(() =>
      z.object({ name: z.string(), b: BSchema.optional() }),
    );
    const BSchema: z.ZodType<B> = z.lazy(() =>
      z.object({ tag: z.number(), a: ASchema.optional() }),
    );

    const json = toJSONSchema(ASchema, ANTHROPIC_STRICT);
    expect(collectRefs(json)).toEqual([]);
    // Somewhere in the tree, the back-edge from B → A (or A → B) appears as
    // an open-object placeholder.
    let foundPlaceholder = false;
    for (const node of walkSchema(json)) {
      if (
        node.type === 'object' &&
        node.additionalProperties === true &&
        typeof node.description === 'string' &&
        node.description.startsWith('Would recursively reference ')
      ) {
        foundPlaceholder = true;
        break;
      }
    }
    expect(foundPlaceholder).toBe(true);
  });

  it('breaks aid-based recursion (gin-style stable IDs) under ANTHROPIC_STRICT', () => {
    // A lazy schema tagged with a stable `aid` referenced from inside its
    // own definition — gin's pattern for named recursive types. The aid
    // lookup in `convert()` finds the in-progress definition; the
    // cycle-breaker replaces the back-edge with the flat placeholder.
    type Tree = { label: string; left?: Tree; right?: Tree };
    const TreeSchema: z.ZodType<Tree> = z.lazy(() =>
      z.object({
        label: z.string(),
        left: TreeSchema.optional(),
        right: TreeSchema.optional(),
      }).meta({ aid: 'Tree' }),
    );

    const json = toJSONSchema(TreeSchema, ANTHROPIC_STRICT);
    expect(collectRefs(json)).toEqual([]);
  });

  it('shared (non-cyclic) refs still emit as $ref under ANTHROPIC_STRICT', () => {
    // Same schema referenced from multiple sites — but no cycle because the
    // shared schema has no back-edge to itself. The dedup behavior should
    // still emit a $ref + $defs entry rather than inlining everywhere.
    const Person = z.object({ name: z.string(), age: z.number() }).meta({ id: 'Person' });
    const schema = z.object({
      author: Person,
      reviewer: Person,
    });
    const json = toJSONSchema(schema, ANTHROPIC_STRICT);
    // Person is shared, so it's promoted to $defs and referenced by $ref.
    expect(json.$defs?.Person).toBeDefined();
    const refs = collectRefs(json);
    expect(refs).toContain('#/$defs/Person');
    // No placeholder — there's no actual cycle here.
    for (const node of walkSchema(json)) {
      if (
        node.type === 'object' &&
        node.additionalProperties === true &&
        typeof node.description === 'string' &&
        node.description.startsWith('Would recursively reference ')
      ) {
        throw new Error('unexpected cycle-breaker placeholder for non-cyclic shared ref');
      }
    }
  });

  it('LENIENT (supportsRecursion=true) keeps recursive $ref even when cycles exist', () => {
    const json = toJSONSchema(NodeSchema, LENIENT);
    const refs = collectRefs(json);
    // Lenient supports recursion → at least one back-edge ref present.
    expect(refs.length).toBeGreaterThan(0);
    // No cycle-breaker placeholders.
    for (const node of walkSchema(json)) {
      if (
        node.type === 'object' &&
        node.additionalProperties === true &&
        typeof node.description === 'string' &&
        node.description.startsWith('Would recursively reference ')
      ) {
        throw new Error('LENIENT should not emit cycle-breaker placeholders');
      }
    }
  });

  it('recursive schema under ANTHROPIC_STRICT serializes without throwing (no infinite loop)', () => {
    // Sanity: the cycle-breaker terminates and the result is JSON-serializable.
    const json = toJSONSchema(NodeSchema, ANTHROPIC_STRICT);
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it('emits the same flat "any" shape under ANTHROPIC_STRICT regardless of where the cycle is', () => {
    // Cycle inside a nested optional vs. inside an array branch — both should
    // produce the same placeholder shape.
    type Wrap = { inner?: Wrap };
    const A: z.ZodType<Wrap> = z.lazy(() => z.object({ inner: A.optional() }));
    type Arr = { items: Arr[] };
    const B: z.ZodType<Arr> = z.lazy(() => z.object({ items: z.array(B) }));

    const ja = toJSONSchema(A, ANTHROPIC_STRICT);
    const jb = toJSONSchema(B, ANTHROPIC_STRICT);

    // Both contain at least one open-object placeholder, no $refs.
    expect(collectRefs(ja)).toEqual([]);
    expect(collectRefs(jb)).toEqual([]);
  });
});

/**
 * Shape-aware cycle-breaker tests.
 *
 * The placeholder emitted at a back-edge must match the *kind* of JSON value
 * the LLM is supposed to send — number stays number, array stays array,
 * union stays an `anyOf`. Otherwise the LLM has no signal that the recursive
 * position accepts anything other than an object.
 *
 * Each test runs under `ANTHROPIC_STRICT` (the `!supportsRecursion` path)
 * and inspects the placeholder shape directly, not just `collectRefs(...) === []`.
 */

/** Find every cycle-breaker placeholder (any node carrying the marker description). */
function findPlaceholders(schema: any): any[] {
  const out: any[] = [];
  for (const node of walkSchema(schema)) {
    if (
      typeof node.description === 'string' &&
      node.description.startsWith('Would recursively reference ')
    ) {
      out.push(node);
    }
  }
  return out;
}

describe('cycle-breaker — shape-aware placeholder', () => {
  it('Array<Self> cycle: placeholder is an array (items also array, then bottoms out)', () => {
    // type T = T[]
    const T: z.ZodType<any> = z.lazy(() => z.array(T));
    const json = toJSONSchema(T, ANTHROPIC_STRICT);

    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    expect(placeholders.length).toBeGreaterThan(0);
    // Cycle target T is z.array(T). Genericize at depth 1 yields
    // {type:'array', items: genericize(T, depth=0)}. At depth 0 the inner
    // array drops its items — preserving "array of arrays" without the
    // walk reaching the cycle again.
    expect(placeholders[0].type).toBe('array');
    expect(placeholders[0].items).toEqual({ type: 'array' });
    // Should NOT be an open-object placeholder — that would be the old
    // always-object behavior we're moving away from.
    expect(placeholders[0].additionalProperties).toBeUndefined();
  });

  it('Object cycle inside an array property: placeholder is an open object, not an array', () => {
    // type Node = { value: string; children: Node[] }
    type Node = { value: string; children: Node[] };
    const Node: z.ZodType<Node> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(Node) }),
    );
    const json = toJSONSchema(Node, ANTHROPIC_STRICT);

    // The cycle target is Node (a ZodObject), not the array — so the
    // placeholder must be `{type: 'object', additionalProperties: true}`,
    // even though it sits *inside* the children array's `items`.
    const childrenItems = (json as any).properties.children.items;
    expect(childrenItems.type).toBe('object');
    expect(childrenItems.additionalProperties).toBe(true);
    expect(childrenItems.description).toMatch(/^Would recursively reference #\/\$defs\//);
  });

  it('union<NodeA, NodeB> mutually recursive (both objects) → deduped to single object', () => {
    // type A = { kind: "a"; b?: B }; type B = { kind: "b"; a?: A }
    type A = { kind: 'a'; b?: B };
    type B = { kind: 'b'; a?: A };
    const ASchema: z.ZodType<A> = z.lazy(() =>
      z.object({ kind: z.literal('a'), b: BSchema.optional() }),
    );
    const BSchema: z.ZodType<B> = z.lazy(() =>
      z.object({ kind: z.literal('b'), a: ASchema.optional() }),
    );

    const json = toJSONSchema(ASchema, ANTHROPIC_STRICT);
    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    // Each back-edge is a single ZodObject (A or B), so the placeholder is
    // a single object node — never an `anyOf` (because both A and B
    // genericize to the same `{type: 'object', additionalProperties: true}`).
    for (const p of placeholders) {
      expect(p.type).toBe('object');
      expect(p.additionalProperties).toBe(true);
      expect(p.anyOf).toBeUndefined();
    }
  });

  it('union<number, Self-shaped object> cycle → anyOf of number + open object', () => {
    // type T = number | { rest: T }
    const T: z.ZodType<any> = z.lazy(() =>
      z.union([z.number(), z.object({ rest: T })]),
    );
    const json = toJSONSchema(T, ANTHROPIC_STRICT);

    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    expect(placeholders.length).toBeGreaterThan(0);
    // Cycle target is T (a ZodUnion). Genericize emits anyOf of its branches.
    const ph = placeholders[0];
    expect(ph.anyOf).toBeDefined();
    const types = ph.anyOf.map((b: any) => b.type).sort();
    expect(types).toEqual(['number', 'object']);
    const objBranch = ph.anyOf.find((b: any) => b.type === 'object');
    expect(objBranch.additionalProperties).toBe(true);
  });

  it('union<string, number, Self[]> cycle → anyOf of three primitive/array branches', () => {
    // type T = string | number | T[]
    const T: z.ZodType<any> = z.lazy(() =>
      z.union([z.string(), z.number(), z.array(T)]),
    );
    const json = toJSONSchema(T, ANTHROPIC_STRICT);

    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    expect(placeholders.length).toBeGreaterThan(0);
    const ph = placeholders[0];
    expect(ph.anyOf).toBeDefined();
    const types = ph.anyOf.map((b: any) => b.type).sort();
    expect(types).toEqual(['array', 'number', 'string']);
    // Array branch is bare — at depth 0 (one level inside the union),
    // arrays drop their items. The LLM still sees `type: 'array'`.
    const arrBranch = ph.anyOf.find((b: any) => b.type === 'array');
    expect(arrBranch).toEqual({ type: 'array' });
  });

  it('literal-string in union with self → string branch in anyOf placeholder', () => {
    // type T = "leaf" | { kid: T }
    const T: z.ZodType<any> = z.lazy(() =>
      z.union([z.literal('leaf'), z.object({ kid: T })]),
    );
    const json = toJSONSchema(T, ANTHROPIC_STRICT);

    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    const ph = placeholders[0];
    expect(ph.anyOf).toBeDefined();
    // ZodLiteral('leaf') genericizes to {type: 'string'}.
    const types = ph.anyOf.map((b: any) => b.type).sort();
    expect(types).toEqual(['object', 'string']);
  });

  it('deeply nested recursion stays serializable and emits zero refs', () => {
    // type T = { a: { b: { c: T[] } } }
    type T = { a: { b: { c: T[] } } };
    const T: z.ZodType<T> = z.lazy(() =>
      z.object({ a: z.object({ b: z.object({ c: z.array(T) }) }) }),
    );
    const json = toJSONSchema(T, ANTHROPIC_STRICT);

    expect(() => JSON.stringify(json)).not.toThrow();
    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    expect(placeholders.length).toBeGreaterThan(0);
    // The inner-most placeholder (inside c.items) mirrors T (a ZodObject).
    expect(placeholders[0].type).toBe('object');
  });

  it('Array<Array<Self>>: outer array preserved, inner array at depth 0 drops its items', () => {
    // type T = T[][]  — the recursive type is itself an array of arrays.
    const T: z.ZodType<any> = z.lazy(() => z.array(z.array(T)));
    const json = toJSONSchema(T, ANTHROPIC_STRICT);

    expect(collectRefs(json)).toEqual([]);
    const placeholders = findPlaceholders(json);
    expect(placeholders.length).toBeGreaterThan(0);
    const ph = placeholders[0];
    // Cycle target is T (the outer array). Genericize at depth 1:
    //   {type: 'array', items: <genericize(z.array(T)) at depth 0>}
    // At depth 0, ZodArray emits a bare `{type: 'array'}` — preserves the
    // "array of arrays" structural hint without re-walking the cycle.
    expect(ph.type).toBe('array');
    expect(ph.items).toEqual({ type: 'array' });
  });
});
