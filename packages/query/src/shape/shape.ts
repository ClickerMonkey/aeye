/**
 * `shape/` — a tiny, zod-free STRUCTURAL-SCHEMA combinator set that lets each
 * expr / query OWN its shape validation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (the end-state this is step 1 of)
 *
 * Today a model-authored query is structurally gated by `zod.safeParse` and
 * SEMANTICALLY validated by the owned `validateWalk` (which NEVER throws and
 * ACCUMULATES every problem in one pass). Zod's structural gate is a second,
 * parallel authority whose failure mode is a flat list of type-named issues.
 *
 * This module is the FOUNDATION for collapsing those two authorities into one:
 * a per-kind {@link Shape} that validates the untrusted JSON at the current
 * `Problems` path, RECORDS one-or-more problems (accumulating, like
 * `validateWalk`), and returns the built value or {@link INVALID} — WITHOUT
 * EVER THROWING. Messages reuse `aids.ts` (`aidInfo` / `didYouMean`) so a
 * failure reads in the query's own vocabulary, never zod's types.
 *
 * NOTE: this is PARALLEL and unit-tested only — it is NOT yet the active gate.
 * Zod stays the structural gate for now; this proves the machinery on a few
 * exemplar exprs (`comparison`, `field-ref`, `literal`, `param`, `logical`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT NEVER THROWS + ACCUMULATES
 *
 * Every combinator's `check` is total: on bad input it PUSHES a problem into
 * `ctx.problems` (at the caller's current path) and returns {@link INVALID}.
 * Composite combinators ({@link obj} / {@link list}) check ALL of their
 * children before deciding — they do NOT early-return on the first bad field —
 * so a single `check` surfaces multiple problems in one pass.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PERFECT TYPE-SAFETY (no `any`, no casts)
 *
 * The only `unknown` is the untrusted `json` input, always narrowed by a type
 * guard ({@link isRecord}, `typeof`, `Array.isArray`, `Number.isInteger`).
 *
 * {@link obj} is fully typed with NO cast: instead of the usual
 * `fields: Record<string, Shape<unknown>>` (whose indexed access erases each
 * field's value type to `unknown`, forcing a cast in the assembler), the
 * generic is INVERTED — `F` is the BUILT-VALUE record, and the field map is a
 * mapped type `{ [K in keyof F]: Shape<F[K]> }`. Indexing that by a key `K`
 * yields `Shape<F[K]>`, so `shape.check(...)` returns exactly `F[K] | INVALID`
 * with no erasure. The partial accumulator is promoted to the complete `F` by
 * the {@link complete} user-defined type GUARD (not a cast) once every required
 * key is present. `build`'s parameter is therefore the precise `F`.
 */
import type { Problems } from '../problem';
import type { Registry } from '../registry';
import type { Expr } from '../expr';
import type { ScalarValue } from '../schema';
import { aidInfo, describeInput, didYouMean } from '../aids';

/** Sentinel returned by a {@link Shape} whose input failed to validate. */
export const INVALID = Symbol('invalid');

/** Threaded through every `check`: the problem accumulator + the registry. */
export interface CheckCtx {
  /** Where problems are recorded (at the caller's current structural path). */
  readonly problems: Problems;
  /** Used by {@link exprRef} to dispatch a child expr defensively. */
  readonly registry: Registry;
}

/**
 * A structural schema for one JSON shape. `check` validates `json` at the
 * CURRENT `ctx.problems` path (callers wrap with `problems.at`), RECORDS any
 * problems, and returns the built value `T` or {@link INVALID}. It MUST NOT
 * throw.
 */
export interface Shape<T> {
  check(json: unknown, ctx: CheckCtx): T | typeof INVALID;
}

/** A plain, non-array object (so string keys can be indexed off it). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `, got <received>` tail for a directed message (empty when absent). */
function gotTail(json: unknown): string {
  const got = describeInput(json);
  return got !== undefined ? `, got ${got}` : '';
}

/**
 * An aid-directed `expected <label>[, got <received>]` message — the shared
 * phrasing behind every scalar mismatch and the dispatch's not-object error.
 * Reuses `aidInfo` (the query-domain label) + `describeInput` from `aids.ts`.
 */
export function expected(aid: string, json: unknown): string {
  return `expected ${aidInfo(aid).label}${gotTail(json)}`;
}

/** Exact-equality shape (used for a `kind` discriminant). Mismatch → INVALID. */
export function lit<const V extends string | number | boolean | null>(value: V): Shape<V> {
  return {
    check(json, ctx) {
      if (json === value) return value;
      ctx.problems.error('shape.literal', `expected ${JSON.stringify(value)}${gotTail(json)}`);
      return INVALID;
    },
  };
}

/** A string. Mismatch → aid-directed `shape.type` + INVALID. */
export function str(aid: string): Shape<string> {
  return {
    check(json, ctx) {
      if (typeof json === 'string') return json;
      ctx.problems.error('shape.type', expected(aid, json));
      return INVALID;
    },
  };
}

/** A number. Mismatch → aid-directed `shape.type` + INVALID. */
export function num(aid: string): Shape<number> {
  return {
    check(json, ctx) {
      if (typeof json === 'number') return json;
      ctx.problems.error('shape.type', expected(aid, json));
      return INVALID;
    },
  };
}

/** An integer (`Number.isInteger`). Mismatch → aid-directed `shape.type` + INVALID. */
export function int(aid: string): Shape<number> {
  return {
    check(json, ctx) {
      if (typeof json === 'number' && Number.isInteger(json)) return json;
      ctx.problems.error('shape.type', expected(aid, json));
      return INVALID;
    },
  };
}

/** A boolean. Mismatch → aid-directed `shape.type` + INVALID. */
export function bool(aid: string): Shape<boolean> {
  return {
    check(json, ctx) {
      if (typeof json === 'boolean') return json;
      ctx.problems.error('shape.type', expected(aid, json));
      return INVALID;
    },
  };
}

/** A leaf scalar (`string | number | boolean | null`). Mismatch → INVALID. */
export function scalar(aid: string): Shape<ScalarValue> {
  return {
    check(json, ctx) {
      if (
        json === null ||
        typeof json === 'string' ||
        typeof json === 'number' ||
        typeof json === 'boolean'
      ) {
        return json;
      }
      ctx.problems.error('shape.type', expected(aid, json));
      return INVALID;
    },
  };
}

/**
 * Membership in `values`. On a miss, emits `expected <label>: a, b, c` plus a
 * `didYouMean` suggestion (when the input is a near-miss string) → INVALID.
 */
export function enumOf<const V extends string>(values: readonly V[], aid: string): Shape<V> {
  return {
    check(json, ctx) {
      if (typeof json === 'string') {
        for (const v of values) if (v === json) return v;
      }
      const suggestion = typeof json === 'string' ? didYouMean(json, values) : '';
      ctx.problems.error('shape.enum', `expected ${aidInfo(aid).label}: ${values.join(', ')}${suggestion}`);
      return INVALID;
    },
  };
}

/** Wrap a shape so an absent / `undefined` value is accepted (→ `undefined`). */
export function optional<T>(inner: Shape<T>): Shape<T | undefined> {
  return {
    check(json, ctx) {
      if (json === undefined) return undefined;
      return inner.check(json, ctx);
    },
  };
}

/**
 * A homogeneous list. Non-array → aid-directed `shape.array` + INVALID; each
 * element is checked at `problems.at(i, …)`; `min` / `max` violations record a
 * problem. Accumulates: every bad element / bound is reported in one pass.
 */
export function list<T>(shape: Shape<T>, opts: { min?: number; max?: number } = {}): Shape<T[]> {
  return {
    check(json, ctx) {
      if (!Array.isArray(json)) {
        ctx.problems.error('shape.array', `expected a list${gotTail(json)}`);
        return INVALID;
      }
      const out: T[] = [];
      let ok = true;
      json.forEach((element, i) => {
        const value = ctx.problems.at(i, () => shape.check(element, ctx));
        if (value === INVALID) ok = false;
        else out.push(value);
      });
      if (opts.min !== undefined && json.length < opts.min) {
        ctx.problems.error('shape.min', `expected at least ${opts.min} item${opts.min === 1 ? '' : 's'}, got ${json.length}`);
        ok = false;
      }
      if (opts.max !== undefined && json.length > opts.max) {
        ctx.problems.error('shape.max', `expected at most ${opts.max} item${opts.max === 1 ? '' : 's'}, got ${json.length}`);
        ok = false;
      }
      return ok ? out : INVALID;
    },
  };
}

/**
 * A homogeneous RECORD — an object of `{ [name: string]: value }` (the named
 * function-argument map). Non-object → aid-directed `shape.not-object` + INVALID;
 * each value is checked at `problems.at(name, …)`; accumulates (every bad value
 * is reported in one pass). Returns an insertion-ordered `Map<string, T>`
 * (mirroring `parseNamedArgs`), so the four function-call exprs keep their args'
 * declared order.
 */
export function record<T>(shape: Shape<T>, aid: string): Shape<Map<string, T>> {
  return {
    check(json, ctx) {
      if (!isRecord(json)) {
        ctx.problems.error('shape.not-object', expected(aid, json));
        return INVALID;
      }
      const out = new Map<string, T>();
      let ok = true;
      for (const key of Object.keys(json)) {
        const value = ctx.problems.at(key, () => shape.check(json[key], ctx));
        if (value === INVALID) ok = false;
        else out.set(key, value);
      }
      return ok ? out : INVALID;
    },
  };
}

/** A child-expr slot: defensively dispatched via `registry.parseCheckedExpr`. */
export function exprRef(): Shape<Expr> {
  return {
    check(json, ctx) {
      const built = ctx.registry.parseCheckedExpr(json, ctx.problems);
      return built === undefined ? INVALID : built;
    },
  };
}

/**
 * A completeness GUARD (not a cast): a `Partial<F>` whose every `required` key
 * is present IS an `F`. This is the seam that lets {@link obj} promote its
 * accumulator to the precise `F` for `build` with no `as`.
 */
function complete<F extends Record<string, unknown>>(
  acc: Partial<F>,
  required: readonly (keyof F)[],
): acc is F {
  return required.every((key) => key in acc);
}

/**
 * An object shape. `fields` maps each key to the {@link Shape} for its value;
 * `build` constructs `T` from the fully-typed parsed values `F` (inferred from
 * the field shapes — see the module header on why the generic is inverted so
 * NO cast is needed).
 *
 * Behavior (never throws, accumulates):
 *  - non-object `json` → aid-directed `shape.not-object` → INVALID;
 *  - EVERY field is checked at `problems.at(key, …)` — a missing non-optional
 *    field records `shape.required`; a field named in `opts.optional` may be
 *    absent — and checking CONTINUES past a bad field so siblings' problems
 *    surface in the same pass;
 *  - if any REQUIRED field is invalid/absent (checked AFTER the siblings) →
 *    INVALID; otherwise `build(values)`.
 */
export function obj<F extends Record<string, unknown>, T>(
  fields: { [K in keyof F]: Shape<F[K]> },
  build: (values: F) => T,
  opts: { optional?: readonly (keyof F & string)[]; aid?: string } = {},
): Shape<T> {
  const optionalKeys = new Set<keyof F>(opts.optional ?? []);
  const keys = Object.keys(fields);
  const required = keys.filter((key) => !optionalKeys.has(key));
  return {
    check(json, ctx) {
      if (!isRecord(json)) {
        ctx.problems.error('shape.not-object', expected(opts.aid ?? 'Expr', json));
        return INVALID;
      }
      const acc: Partial<F> = {};
      const checkKey = <K extends keyof F & string>(key: K): void => {
        const shape: Shape<F[K]> = fields[key];
        ctx.problems.at(key, () => {
          if (!(key in json)) {
            if (!optionalKeys.has(key)) {
              ctx.problems.error('shape.required', `missing required field \`${key}\``);
            }
            return;
          }
          const value = shape.check(json[key], ctx);
          if (value !== INVALID) acc[key] = value;
        });
      };
      for (const key of keys) checkKey(key);
      // Only reached `build` when every required field parsed — the guard then
      // narrows the accumulator to the complete `F` (no cast).
      if (!complete(acc, required)) return INVALID;
      return build(acc);
    },
  };
}
