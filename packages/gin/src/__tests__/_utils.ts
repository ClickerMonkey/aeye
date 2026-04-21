import { Value } from '../value';

/**
 * Recursively unwrap a Value (and any nested Values inside composite raws)
 * into plain JSON-ish primitives. Unlike `Value.encode()` (which emits the
 * `{type, value}` envelope form for round-trip), this drops all type info
 * and returns what tests traditionally called "logical primitive view".
 *
 * Only used by tests — production code should use `encode()`/`toJSON()`.
 */
export function primitives(v: Value): unknown {
  return toPrim(v.raw);
}

function toPrim(x: unknown): unknown {
  if (x instanceof Value) return toPrim(x.raw);
  if (x === null || x === undefined) return x;
  if (Array.isArray(x)) return x.map(toPrim);
  if (x instanceof Map) {
    return Array.from(x.entries()).map(([, entry]) => {
      if (Array.isArray(entry) && entry.length === 2) {
        return [toPrim(entry[0]), toPrim(entry[1])];
      }
      return entry;
    });
  }
  if (x instanceof Date) return x;
  if (typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x)) out[k] = toPrim(val);
    return out;
  }
  return x;
}
