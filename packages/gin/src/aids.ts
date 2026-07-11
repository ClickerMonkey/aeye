/**
 * "Did you mean?" typo-suggestion helpers for gin's unknown-NAME diagnostics.
 *
 * Every place gin reports an unknown name — an unbound variable, a missing
 * prop / method, an unregistered type / interface — can append the nearest
 * VALID name so a model (or human) sees the fix inline:
 *
 *   `unknown variable 'titel'` → `unknown variable 'titel' — did you mean \`title\`?`
 *
 * The suggester is deliberately conservative: it fires only on a GENUINE typo,
 * never on an unrelated word. Distance is Levenshtein, compared
 * case-insensitively, and gated by a small length-scaled budget (see
 * {@link suggestionBudget}), so a short name tolerates one edit and a long one
 * up to three — enough for a real misspelling, not enough to match a different
 * word of similar length.
 *
 * Ported verbatim (algorithm-identical) from `@aeye/query`'s `aids.ts`; the
 * zod-issue plumbing there is intentionally left out — gin needs only the pure
 * string helpers.
 */

/**
 * Levenshtein edit distance between two strings (classic DP over one rolling
 * row). Insertions, deletions, and substitutions each cost 1.
 */
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

/**
 * The edit-distance BUDGET tolerated for an input of `len` characters: a small,
 * length-scaled allowance (`floor(len/3)`, at least 1, capped at 3). Scaling
 * keeps a suggestion honest — a short word tolerates a single edit, a longer one
 * up to three — so a match only ever fires on a genuine typo, never on an
 * unrelated word of similar length.
 */
export function suggestionBudget(len: number): number {
  return Math.min(3, Math.max(1, Math.floor(len / 3)));
}

/**
 * Rank `candidates` by how close each is to `input`, keeping only those within
 * `budget` edits (a genuine typo). Distance is computed CASE-INSENSITIVELY (so
 * `TITEL` still matches `title`); ties break by the case-SENSITIVE distance
 * (favoring the exact-case spelling) and then the candidates' original order.
 * Returns the surviving candidates, nearest first.
 */
function rankNear(input: string, candidates: readonly string[], budget: number): string[] {
  const lower = input.toLowerCase();
  const scored = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      ci: editDistance(lower, candidate.toLowerCase()),
      exact: editDistance(input, candidate),
    }))
    .filter((s) => s.ci <= budget);
  scored.sort((a, b) => a.ci - b.ci || a.exact - b.exact || a.index - b.index);
  return scored.map((s) => s.candidate);
}

/**
 * The single nearest candidate to `input` within `budget` edits, or `undefined`
 * when nothing is close enough (so a caller can list the alternatives without a
 * false suggestion). `budget` defaults to {@link suggestionBudget} of the
 * input's length — the reusable "genuine typo" primitive behind
 * {@link didYouMean}.
 */
export function nearest(
  input: string,
  candidates: readonly string[],
  budget: number = suggestionBudget(input.length),
): string | undefined {
  return rankNear(input, candidates, budget)[0];
}

/**
 * A ready-to-append `" — did you mean \`X\`?"` (or `" — did you mean \`X\` or
 * \`Y\`?"` for up to `opts.max` near matches, default 1) suggesting the valid
 * name(s) closest to a bad `input`, or `''` when nothing is a genuine typo of
 * any candidate. Case-insensitive with a length-scaled edit budget (see
 * {@link suggestionBudget}), so it only fires on a real misspelling — never on
 * an unrelated word. Append it directly to an "unknown name" diagnostic:
 *
 *   p.error('var.unknown',
 *     `unknown variable '${bad}'${didYouMean(bad, [...scope.keys()])}`);
 */
export function didYouMean(
  input: string,
  candidates: readonly string[],
  opts: { max?: number } = {},
): string {
  const max = Math.max(1, opts.max ?? 1);
  const matches = rankNear(input, candidates, suggestionBudget(input.length)).slice(0, max);
  if (matches.length === 0) return '';
  return ` — did you mean ${orList(matches.map((m) => `\`${m}\``))}?`;
}

/** Join items into an English `a`, `a or b`, or `a, b, or c` list (Oxford comma). */
function orList(items: readonly string[]): string {
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  if (items.length > 2) return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
  // 0 (unreached via `didYouMean`) or 1 item → a plain join.
  return items.join(', ');
}
