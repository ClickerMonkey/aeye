import type { DescriptorFamily, FormatDescriptor } from './descriptor';
import type { ToJSONSchemaOptions } from './json-schema';
import { checkDescriptorConsistency } from './consistency';
import { LENIENT } from './dialects/lenient';
import { OPENAI_STRICT, OPENAI_NON_STRICT } from './dialects/openai';
import { ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT } from './dialects/anthropic';
import { GOOGLE_STRICT, GOOGLE_NON_STRICT } from './dialects/google';
import { XAI_STRICT, XAI_NON_STRICT } from './dialects/xai';

// ============================================================================
// Descriptor registry — mutable lookup tables for built-in + user-registered
// descriptors. `registerDescriptor` adds to both maps; `getDescriptor` /
// `getDescriptorById` consult them on every lookup so newly-registered
// descriptors are immediately addressable by family or id.
// ============================================================================

const DESCRIPTORS_BY_ID = new Map<string, FormatDescriptor>();
// Keyed by family name. Each family slot holds its strict and lenient variants.
// `'lenient'` always points to `LENIENT` for both keys.
const DESCRIPTORS_BY_FAMILY = new Map<string, { strict?: FormatDescriptor; lenient?: FormatDescriptor }>();

function indexDescriptor(d: FormatDescriptor): void {
  DESCRIPTORS_BY_ID.set(d.id, d);
  const slot = DESCRIPTORS_BY_FAMILY.get(d.family) ?? {};
  if (d.strict) slot.strict = d;
  else slot.lenient = d;
  DESCRIPTORS_BY_FAMILY.set(d.family, slot);
}

// Seed the registry with built-ins.
for (const d of [
  LENIENT,
  OPENAI_STRICT, OPENAI_NON_STRICT,
  ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT,
  GOOGLE_STRICT, GOOGLE_NON_STRICT,
  XAI_STRICT, XAI_NON_STRICT,
]) {
  indexDescriptor(d);
}

/**
 * Register a custom `FormatDescriptor` so it can be looked up by `id` or
 * by `(family, strict)`. Useful for adding support for a new provider
 * dialect or for registering a tweaked variant of an existing family.
 *
 * The descriptor's `id` and `family` become the lookup keys. If a
 * descriptor with the same id is already registered, the new one
 * replaces it. The family slot tracks one strict and one lenient
 * variant; registering a third variant overwrites the matching slot.
 *
 * Built-in descriptors (`OPENAI_STRICT`, `LENIENT`, etc.) are seeded at
 * module load — you don't need to register them manually. They CAN be
 * overridden by registering a same-id descriptor afterwards, but doing
 * so is generally a sign that you should pick a different id.
 *
 * @example
 * ```ts
 * import { registerDescriptor, OPENAI_STRICT } from '@aeye/core';
 *
 * // A tighter OpenAI-flavored descriptor: same wire shape but with
 * // pattern support disabled (some downstream tools choke on regex).
 * registerDescriptor({
 *   ...OPENAI_STRICT,
 *   id: 'openai-no-regex',
 *   family: 'openai-no-regex',
 *   allowPattern: false,
 *   allowMultiplePatterns: false,
 * });
 *
 * // Now resolvable:
 * getDescriptor('openai-no-regex', true);   // → the registered descriptor
 * getDescriptorById('openai-no-regex');     // → same
 * ```
 *
 * A descriptor that contradicts itself (see `checkDescriptorConsistency`) is
 * still registered — the caller may know something we don't — but each
 * problem is warned once at registration, because the alternative is finding
 * out from a provider's HTTP 400.
 */
export function registerDescriptor(descriptor: FormatDescriptor): void {
  for (const problem of checkDescriptorConsistency(descriptor)) {
    console.warn(`FormatDescriptor '${descriptor.id}' is inconsistent: ${problem}`);
  }
  indexDescriptor(descriptor);
}

/**
 * Resolve a descriptor by family + strictness.
 *
 * Built-in families (`'openai'`, `'anthropic'`, `'google'`) always
 * resolve. Custom families registered via `registerDescriptor` resolve
 * once they're registered. Unknown families fall back to `LENIENT`
 * (safe default — strict mode silently degrades for unrecognized models).
 *
 * @param family - provider family (built-in or registered)
 * @param strict - whether the strict variant is wanted
 */
export function getDescriptor(family: DescriptorFamily, strict: boolean): FormatDescriptor {
  if (!strict) {
    const slot = DESCRIPTORS_BY_FAMILY.get(family);
    return slot?.lenient ?? LENIENT;
  }
  const slot = DESCRIPTORS_BY_FAMILY.get(family);
  return slot?.strict ?? LENIENT;
}

/**
 * Look up a descriptor by id. Returns LENIENT for unknown ids (safe default).
 * Custom descriptors registered via `registerDescriptor` are reachable here
 * by their `id`.
 */
export function getDescriptorById(id: string | undefined): FormatDescriptor {
  if (!id) return LENIENT;
  return DESCRIPTORS_BY_ID.get(id) ?? LENIENT;
}

/**
 * True if `family` has at least one registered descriptor (strict or
 * lenient). Used by `@aeye/ai`'s `resolveStrictFormat` fallback chain to
 * decide whether a model id prefix or provider name is a recognized
 * dialect.
 */
export function hasDescriptorFamily(family: string | undefined): boolean {
  if (family === undefined) return false;
  return DESCRIPTORS_BY_FAMILY.has(family);
}

/**
 * Resolve descriptor from various input shapes (boolean, options object, or descriptor).
 * Used by `toJSONSchema` to support its overloaded signature.
 */
export function resolveDescriptor(
  input: FormatDescriptor | ToJSONSchemaOptions | boolean | undefined,
): FormatDescriptor {
  if (input === undefined) return OPENAI_STRICT;
  if (typeof input === 'boolean') return input ? OPENAI_STRICT : LENIENT;
  if ('id' in input && 'family' in input) return input as FormatDescriptor;
  const opts = input as ToJSONSchemaOptions;
  return getDescriptor(opts.format ?? 'openai', opts.strict);
}
