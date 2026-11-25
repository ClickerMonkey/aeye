// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * A definition object without its keys whose value is `undefined`.
 *
 * Every `toJSON` builds its definition as one literal with optional slots
 * (`docs: this.docs`, `get: this.get?.toJSON()`), which leaves a key holding
 * `undefined` wherever a slot is empty. That is not JSON: a consumer that
 * validates the definition with a strict schema, compares it structurally or
 * hashes it sees keys `JSON.stringify` would drop. Each `toJSON` passes its
 * literal through here, so a definition is plain JSON as it leaves gin.
 */
export function defined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}
