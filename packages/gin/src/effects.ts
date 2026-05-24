/**
 * Effects — categorical side-effect classification for Exprs.
 *
 * Each Expr declares what categories of side effect its evaluation can
 * produce via `Expr.effects(): Effects`. Categories combine bitwise so
 * a single value can carry any subset.
 *
 * Categories:
 *   - NONE     — pure computation; no observable effect outside the
 *                expression's own value
 *   - STATE    — mutates program state visible to the program itself:
 *                scope-variable assignment (`set`), control-flow
 *                transfer (`flow:break/continue/return/throw/exit`)
 *   - SYSTEM   — mutates state outside the program (files, processes,
 *                persistent stores). Reserved for natives that need
 *                to declare permanent side effects.
 *   - EXTERNAL — reaches out to an external service or interaction
 *                channel (HTTP, LLM, user prompt). Distinct from
 *                SYSTEM in that the call is request/response rather
 *                than a local mutation.
 *
 * Used by static analysis to surface no-op patterns — e.g. a `loop`
 * whose body's `effects()` is NONE is a no-op, since loops discard
 * their body's value.
 */
export const Effects = {
  NONE:     0,
  STATE:    1 << 0,
  SYSTEM:   1 << 1,
  EXTERNAL: 1 << 2,
} as const;
export type Effects = number;

/** Combine any number of Effects values via bitwise-or. */
export function combine(...es: Effects[]): Effects {
  let acc: Effects = Effects.NONE;
  for (const e of es) acc |= e;
  return acc;
}

/** True iff `e` carries any of the bits in `mask`. */
export function has(e: Effects, mask: Effects): boolean {
  return (e & mask) !== 0;
}

/** Render an Effects value as a human label, e.g. `"STATE|EXTERNAL"`
 *  or `"NONE"`. Useful in warning messages so the model sees which
 *  categories are present (or missing). */
export function formatEffects(e: Effects): string {
  if (e === Effects.NONE) return 'NONE';
  const parts: string[] = [];
  if (e & Effects.STATE) parts.push('STATE');
  if (e & Effects.SYSTEM) parts.push('SYSTEM');
  if (e & Effects.EXTERNAL) parts.push('EXTERNAL');
  return parts.join('|');
}
