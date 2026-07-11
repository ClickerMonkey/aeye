/**
 * Shared source-name collision detection.
 *
 * Under the type-named source model, every source a query binds (the FROM
 * source, each join hop, and — Phase C — a DML target) is referenced by its
 * TYPE NAME unless explicitly aliased. Two sources sharing one bound name is
 * therefore an ambiguity the author must resolve, so we report it as a
 * validation error (`source.duplicate`) pointing them at the `aliased` escape
 * hatch (or a join `as`).
 *
 * This lives at the QUERY level — NOT in `QueryScope.bind` — so a nested
 * subquery may legitimately reuse a name that exists in an outer scope; only
 * names bound within the SAME query collide.
 */
import type { Problems } from '../problem';

/** One source bound by a query, for collision reporting. */
export interface BoundSource {
  /** The name the source is bound under (what field-refs reference). */
  name: string;
  /**
   * The underlying Type name — used to phrase the `aliased` disambiguation
   * hint. For a subquery (no Type) this is just the bound name.
   */
  type: string;
}

/**
 * Report a `source.duplicate` error for every bound name that appears more
 * than once in `sources` (each duplicated name reported once, on its first
 * repeat). `sources` MUST preserve duplicates — do not pass a de-duplicated
 * map's keys.
 */
export function reportDuplicateSources(p: Problems, sources: readonly BoundSource[]): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.name) && !reported.has(s.name)) {
      reported.add(s.name);
      p.error(
        'source.duplicate',
        `Source name '${s.name}' is bound more than once; use ` +
          `{ kind:'aliased', type:'${s.type}', as:'<alias>' } (or a join \`as\`) to disambiguate.`,
      );
    }
    seen.add(s.name);
  }
}
