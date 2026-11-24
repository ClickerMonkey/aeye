/**
 * "Did you mean?" for the model's mistakes: an unknown key, an enum value, a
 * literal or discriminator tag, a tool name.
 *
 * Ported algorithm-identical from `@aeye/query`'s `aids.ts` (gin's `aids.ts`
 * is the same port), so a suggestion here is exactly the one gin and query
 * make for the same input:
 *
 * - Levenshtein distance, compared case-insensitively;
 * - a length-scaled budget (`floor(len / 3)`, at least 1, at most 3), so it
 *   fires on a genuine typo and never on an unrelated word;
 * - ties broken by the case-sensitive distance, then the candidates' order.
 *
 * One addition that cannot change a result: candidates whose length differs
 * from the input's by more than the budget are skipped before the distance
 * is computed (their distance is at least that difference). A widened enum of
 * thousands of values then costs a length check per value.
 */

/** Levenshtein edit distance (one rolling row). */
export function editDistance(a: string, b: string): number {
  const prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The edit budget tolerated for an input of `len` characters: `floor(len / 3)`, at least 1, at most 3. */
export function suggestionBudget(len: number): number {
  return Math.min(3, Math.max(1, Math.floor(len / 3)));
}

/** Candidates within `budget` edits of `input`, nearest first (case-insensitive; ties: exact case, then order). */
export function rankNear(input: string, candidates: readonly string[], budget: number = suggestionBudget(input.length)): string[] {
  const lower = input.toLowerCase();
  const scored: { candidate: string; index: number; ci: number; exact: number }[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    if (Math.abs(candidate.length - input.length) > budget) continue;
    const ci = editDistance(lower, candidate.toLowerCase());
    if (ci <= budget) scored.push({ candidate, index, ci, exact: editDistance(input, candidate) });
  }
  scored.sort((a, b) => a.ci - b.ci || a.exact - b.exact || a.index - b.index);
  return scored.map((s) => s.candidate);
}

/** The nearest candidate within the budget, or `undefined` when nothing is a genuine typo of one. */
export function nearest(input: string, candidates: readonly string[], budget?: number): string | undefined {
  return rankNear(input, candidates, budget)[0];
}

/** `" — did you mean `X`?"` (up to `max` matches, default 1), or `''`. The same wording as gin and query. */
export function didYouMean(input: string, candidates: readonly string[], opts: { readonly max?: number } = {}): string {
  const max = Math.max(1, opts.max ?? 1);
  const matches = rankNear(input, candidates).slice(0, max);
  if (!matches.length) return '';
  return ` — did you mean ${orList(matches.map((m) => `\`${m}\``))}?`;
}

/** `a`, `a or b`, `a, b, or c`. */
export function orList(items: readonly string[]): string {
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  if (items.length > 2) return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
  return items.join(', ');
}
