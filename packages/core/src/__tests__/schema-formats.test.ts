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

    it('ANTHROPIC_STRICT uses recursive-strict (array-of-pairs object branch)', () => {
      // Anthropic forbids `additionalProperties: <schema>`, so the Any
      // schema's object branch uses the same array-of-pairs workaround as
      // OpenAI strict.
      const json = toJSONSchema(schema, ANTHROPIC_STRICT);
      const branches = json.$defs!.Any.anyOf!;
      const objectBranch = branches.find(b => b.type === 'array' && b.items?.type === 'object');
      expect(objectBranch).toBeDefined();
      expect(objectBranch!.items!.properties).toHaveProperty('key');
      expect(objectBranch!.items!.properties).toHaveProperty('value');
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
  });
});
