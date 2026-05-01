import { z } from 'zod';
import type { TypeDef } from '@aeye/gin';
import { buildSchemas } from '@aeye/gin';
import { ai } from '../ai';

/**
 * Edit a saved type's definition. The proposed new TypeDef must be
 * compatible with the old one — every value of the OLD shape must
 * still satisfy the NEW shape — so existing callers and saved data
 * keep working.
 *
 * Allowed edits (compatible widening):
 *   - Adding OPTIONAL fields to an obj.
 *   - Widening an existing field's type (`y: num` → `y: num | text`).
 *   - Loosening constraints (`text{minLength=5}` → `text{minLength=2}`),
 *     subject to the type's own narrow / widen rules.
 *
 * Rejected edits (would break callers):
 *   - Removing a required field.
 *   - Adding a required field.
 *   - Narrowing a field type (`num` → `num{min=0}` is fine; `num` →
 *     `text` is not).
 *   - Changing the underlying type class (e.g. `obj` → `list`).
 */
export const editType = ai.tool({
  name: 'edit_type',
  description: 'Replace a saved type with a new definition; rejects breaking changes.',
  instructions:
    'Update an existing named type. The new definition is checked against the old: every value of the OLD shape must still satisfy the NEW shape. ' +
    'Use this to widen field types, add optional fields, or loosen constraints. ' +
    'Removing fields, adding REQUIRED fields, or narrowing types is rejected — those would break existing values / callers.',
  schema: (ctx) => {
    const opts = buildSchemas(ctx.registry);
    return z.object({
      name: z.string().describe('Name of the saved type to edit (matches the file at `./types/<name>.json`).'),
      def: (opts.Type as z.ZodType<TypeDef>).describe(
        'The new TypeDef. Its `name` must match the type being edited; the structural change must be backwards-compatible.',
      ),
    });
  },
  call: async (input: { name: string; def: TypeDef }, _refs, ctx) => {
    let oldDef: TypeDef;
    try {
      oldDef = ctx.store.readType(input.name);
    } catch {
      return `// FAILED: type '${input.name}' not found at \`./types/${input.name}.json\`. Use \`find_or_create_types\` to create new types instead.`;
    }

    if ((input.def as { name?: string }).name !== input.name) {
      return `// FAILED: edit definition's name '${(input.def as { name?: string }).name}' must match the type being edited ('${input.name}').`;
    }

    let oldType, newType;
    try {
      oldType = ctx.registry.parse(oldDef);
    } catch (e: unknown) {
      return `// FAILED: could not parse the existing on-disk type '${input.name}': ${e instanceof Error ? e.message : String(e)}.`;
    }
    try {
      newType = ctx.registry.parse(input.def);
    } catch (e: unknown) {
      return `// FAILED: could not parse the proposed new type definition: ${e instanceof Error ? e.message : String(e)}.`;
    }

    // Compatibility check: every OLD-typed value must satisfy NEW.
    // `newType.compatible(oldType)` returns true when "new accepts every
    // value of old" — exactly the condition we want for edit-safety.
    if (!newType.compatible(oldType)) {
      return (
        `// FAILED: the proposed type for '${input.name}' is NOT a backwards-compatible widening of the existing one.\n` +
        `// Old: ${safeToCode(oldType)}\n` +
        `// New: ${safeToCode(newType)}\n` +
        `// Allowed: add OPTIONAL fields, widen existing field types, loosen constraints.\n` +
        `// Rejected: removing fields, adding required fields, narrowing field types, changing the type class.`
      );
    }

    try {
      ctx.store.writeType(input.def);
    } catch (e: unknown) {
      return `// FAILED: edit passed compat check but writing to disk threw: ${e instanceof Error ? e.message : String(e)}.`;
    }

    return `Type '${input.name}' updated. New surface: ${safeToCode(newType)}`;
  },
});

function safeToCode(t: { toCode?: () => string; name?: string } | undefined): string {
  if (!t) return '<unparsed>';
  try { return (t.toCode?.() ?? t.name) ?? '<unrenderable>'; }
  catch { return t.name ?? '<unrenderable>'; }
}
