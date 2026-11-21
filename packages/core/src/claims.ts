/**
 * Parallel claims: what a tool call operates on, so calls that touch the same
 * things never run at the same time.
 *
 * A tool declares its claims (`ToolInput.parallelClaims`), statically or from
 * its parsed arguments and context, as plain strings such as
 * `file:src/index.ts` or `db:users`. When a prompt runs a batch of tool calls
 * in parallel, a call whose claims conflict with an earlier call in the batch
 * (in the order the model made them) waits for that call to finish, then
 * runs. Calls that share nothing still run together.
 *
 * The rule lives here, apart from the prompt loop, so any other scheduler of
 * tool calls can apply exactly the same one.
 */

/**
 * The claims of one tool call. An empty list claims nothing and conflicts
 * with nothing (except a call that runs alone, see `ALL_CLAIMS`).
 */
export type ToolClaims = readonly string[];

/**
 * A claim that conflicts with every other call in the batch, whatever that
 * call claims or whether it claims anything: the call runs alone. Earlier
 * calls finish before it starts, and later calls wait for it.
 */
export const ALL_CLAIMS = '*';

/**
 * Claims that claim nothing.
 */
export const NO_CLAIMS: ToolClaims = [];

/**
 * Whether two calls with these claims must not run at the same time: they
 * share a claim (exact string equality), or either one claims `ALL_CLAIMS`.
 */
export function claimsConflict(a: ToolClaims, b: ToolClaims): boolean {
  if (a.includes(ALL_CLAIMS) || b.includes(ALL_CLAIMS)) {
    return true;
  }
  return a.some(claim => b.includes(claim));
}

/**
 * For each call in a batch, given each call's claims in the order the model
 * made the calls, the indices of the earlier calls it must wait for. A call
 * only ever waits for earlier calls, so waiting can't deadlock, and calls
 * with conflicting claims always run in model order.
 *
 * @example
 * claimWaits([['file:a'], ['file:b'], ['file:a'], ['*']])
 * // → [[], [], [0], [0, 1, 2]]
 */
export function claimWaits(claims: readonly ToolClaims[]): number[][] {
  return claims.map((mine, index) => {
    const waits: number[] = [];
    for (let earlier = 0; earlier < index; earlier++) {
      if (claimsConflict(mine, claims[earlier])) {
        waits.push(earlier);
      }
    }
    return waits;
  });
}
