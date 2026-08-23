/**
 * `FormatDescriptor.maxEnumValues` — the opt-in, dialect-level ceiling on how
 * many values one emitted `enum` may carry, and the WIDENING it triggers.
 *
 * Two halves, and the second is as important as the first:
 *
 *  1. When a descriptor declares a cap, an over-cap `enum` is emitted as its
 *     plain scalar `type` with every value listed in the `description` — a
 *     widened schema, never a truncated one. Truncating would make the values
 *     past the cap unreachable; widening keeps the model's information complete
 *     and moves enforcement to whatever validates the answer afterwards.
 *  2. **No built-in descriptor declares a cap**, and that is a measured result.
 *     The field was added because a large `enum` was believed to make Gemini
 *     answer `400 INVALID_ARGUMENT`; measured against
 *     `google/gemini-3-flash-preview` via OpenRouter, enums up to 2048 values
 *     (52 KB of tool schema) return HTTP 200, under forced and automatic tool
 *     choice alike. The provenance and its caveat live on the field's doc
 *     comment. The test below is the guard against someone re-adding an
 *     unmeasured cap and silently dropping structural enforcement.
 */

import { z } from 'zod';
import {
  ANTHROPIC_NON_STRICT,
  ANTHROPIC_STRICT,
  GOOGLE_NON_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_NON_STRICT,
  OPENAI_STRICT,
  toJSONSchema,
  type FormatDescriptor,
} from '../index';

/** A synthetic dialect that DOES cap, so the mechanism is exercised without
 *  pretending a built-in provider has a limit we could not measure. */
const CAP = 8;
const CAPPED: FormatDescriptor = Object.freeze({ ...LENIENT, id: 'test-capped', family: 'test-capped', maxEnumValues: CAP });

/** Comfortably over the synthetic cap. */
const MANY = Array.from({ length: 20 }, (_, i) => `name_${i}`);
const FEW = MANY.slice(0, CAP);

const render = (schema: z.ZodType, descriptor: FormatDescriptor) => toJSONSchema(schema, descriptor);

describe('an over-cap enum WIDENS — it is never truncated', () => {
  it('drops the `enum` keyword and keeps the scalar type', () => {
    const json = render(z.enum(MANY), CAPPED);
    expect(json.enum).toBeUndefined();
    expect(json.type).toBe('string');
  });

  it('lists EVERY value in the description — nothing becomes unreachable', () => {
    const json = render(z.enum(MANY), CAPPED);
    // Every value must survive into the description — that is the whole point
    // of widening rather than truncating.
    for (const value of MANY) {
      expect(json.description).toContain(value);
    }
    expect(json.description).toContain(`${MANY.length} values`);
  });

  it('an enum AT the cap is still a real enum', () => {
    const json = render(z.enum(FEW), CAPPED);
    expect(json.enum).toEqual(FEW);
    expect(json.description).toBeUndefined();
  });

  it('widens a NESTED enum, wherever it sits in the schema', () => {
    const json = render(z.object({ pick: z.enum(MANY), tags: z.array(z.enum(MANY)) }), CAPPED);
    expect(json.properties?.['pick']?.enum).toBeUndefined();
    expect(json.properties?.['pick']?.type).toBe('string');
    expect(json.properties?.['tags']?.items?.enum).toBeUndefined();
    expect(json.properties?.['tags']?.items?.description).toContain(MANY[MANY.length - 1]);
  });

  it('keeps the schema OWN description alongside the value list', () => {
    // `convert()` copies the source schema's metadata over the converted node,
    // so without the merge the value list would be silently replaced — leaving
    // a bare `{type:'string'}` that says nothing about which strings are legal.
    const json = render(z.enum(MANY).describe('Which capability to attach.'), CAPPED);
    expect(json.description).toContain('Which capability to attach.');
    expect(json.description).toContain(MANY[0]);
    expect(json.description).toContain(MANY[MANY.length - 1]);
  });

  it('widens a NUMERIC enum to `number`, not to `string`', () => {
    const numbers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, i] as const));
    const json = render(z.nativeEnum(numbers), CAPPED);
    expect(json.enum).toBeUndefined();
    expect(json.type).toBe('number');
    expect(json.description).toContain('19');
  });

  it('widens a multi-value literal, which emits the same `enum` keyword', () => {
    const json = render(z.literal(MANY), CAPPED);
    expect(json.enum).toBeUndefined();
    expect(json.description).toContain(MANY[MANY.length - 1]);
  });

  it('leaves a single-value literal alone — it emits `const`, which no cap bounds', () => {
    const json = render(z.literal('only'), CAPPED);
    expect(json.const).toBe('only');
    expect(json.enum).toBeUndefined();
    expect(json.description).toBeUndefined();
  });
});

describe('only the Google descriptors cap enums — measured, not assumed', () => {
  // An `enum` is the more correct encoding whenever it fits, because it is the
  // one the model structurally cannot answer outside of. Declaring a cap trades
  // that guarantee away, so a built-in may only declare one against a measured
  // provider rejection. If this test starts failing for a NON-Google descriptor,
  // that descriptor owes a measurement in its doc comment before gaining a cap;
  // if it fails for a Google descriptor because the cap moved, the new value
  // needs its own measurement recorded in `FormatDescriptor.maxEnumValues`.
  it.each([
    ['LENIENT', LENIENT],
    ['OPENAI_STRICT', OPENAI_STRICT],
    ['OPENAI_NON_STRICT', OPENAI_NON_STRICT],
    ['ANTHROPIC_STRICT', ANTHROPIC_STRICT],
    ['ANTHROPIC_NON_STRICT', ANTHROPIC_NON_STRICT],
  ] as const)('%s declares no cap and emits every value', (_name, descriptor) => {
    expect(descriptor.maxEnumValues).toBeUndefined();
    const json = render(z.enum(MANY), descriptor);
    expect(json.enum).toEqual(MANY);
    expect(json.description).toBeUndefined();
  });

  // GOOGLE_STRICT/GOOGLE_NON_STRICT declare 40 — a real `400 INVALID_ARGUMENT`
  // was reproduced against this product's actual live fn-catalog enum (98 real
  // component/fn names; 90 passed, 93 failed), and the widen-to-string fallback
  // was verified to fix that exact failing request. See the field's doc comment
  // for the full bisection and why 40 (not the measured 90-92 edge) was chosen.
  it.each([
    ['GOOGLE_STRICT', GOOGLE_STRICT],
    ['GOOGLE_NON_STRICT', GOOGLE_NON_STRICT],
  ] as const)('%s caps at 40 and widens past it', (_name, descriptor) => {
    expect(descriptor.maxEnumValues).toBe(40);
    const atCap = Array.from({ length: 40 }, (_, i) => `name_${i}`);
    const overCap = Array.from({ length: 41 }, (_, i) => `name_${i}`);
    const atCapJson = render(z.enum(atCap), descriptor);
    expect(atCapJson.enum).toEqual(atCap);
    const overCapJson = render(z.enum(overCap), descriptor);
    expect(overCapJson.enum).toBeUndefined();
    expect(overCapJson.type).toBe('string');
    for (const value of overCap) expect(overCapJson.description).toContain(value);
  });
});
