import z from 'zod';

/**
 * The key an EAGER walk's cycle guard must use for `s`.
 *
 * Object identity alone is a broken guard, because a `z.lazy` is only required
 * to return *a* schema — not the *same* schema object — from its getter. A
 * codegen layer that derives zod from a live type registry rebuilds the subtree
 * on every call (`@aeye/gin`'s `buildSchemas` does), so each re-entry into a
 * recursive node is a FRESH object: an identity guard never fires, the walk
 * descends forever, and because every level allocates a whole new subtree
 * (measured ~9.4 KB/level) the process dies of heap exhaustion —
 * `FATAL ERROR: Ineffective mark-compacts near heap limit` — rather than
 * overflowing the stack. `convert()` already survives this by matching a cached
 * definition on the `aid` such a layer stamps on the node (see its `ZodLazy`
 * branch), so the eager walkers key on the SAME identity: a declared
 * `aid`/`id` names the definition, and only an unnamed node falls back to
 * object identity.
 *
 * The two IDs are read in `convert()`'s own precedence (`aid` then `id`), and
 * carry the same meaning here that they do there: two nodes sharing one
 * declared id ARE one definition.
 */
export function walkKey(s: z.ZodType | z.core.$ZodType): z.ZodType | z.core.$ZodType | string {
  if (!(s instanceof z.ZodType)) return s;
  const meta = s.meta();
  const declared = meta?.aid ?? meta?.id;
  // Prefixed so a declared id can never be mistaken for anything else in the
  // guard's key space (the alternative member is an object, so this is belt +
  // braces against a future string-keyed member).
  return typeof declared === 'string' ? `id:${declared}` : s;
}
