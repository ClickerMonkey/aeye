/**
 * DIRECTED, domain-specific schema-failure messages.
 *
 * The LLM query schema is a deep tree of `.or`-folded discriminated unions,
 * enums, records and objects. When a model emits a malformed query, Zod's stock
 * messages ("expected object, received string", "Value does not match any of
 * the allowed shapes") name Zod's TYPES, not the query DOMAIN — so the model has
 * to reverse-engineer which construct it got wrong.
 *
 * This module makes every generated schema node carry an **`aid`** (a stable
 * identifier) plus a per-schema, aid-directed **error map** so the SAME failure
 * reads in the query's own vocabulary instead:
 *  - a wrong-shape / `invalid_type` → `expected <label>[, got <received>]`
 *    (e.g. "expected an expression, got a string");
 *  - a union `.or` no-match whose value carries a bogus string `kind` →
 *    "unknown <noun> kind `<kind>` — did you mean `<nearest>`? (available: …)"
 *    via a small edit-distance over the union's branch kinds; else the union's
 *    own `<label>` ("expected an expression");
 *  - an enum failure → `expected <label>: <allowed values>` (e.g. "expected a
 *    comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike").
 *
 * `withAid(schema, aid, opts?)` is the single seam: it attaches `.meta({ aid })`
 * (so the JSON-schema `$defs` key is unchanged) AND a captured error closure
 * that renders the directed text off {@link AID_REGISTRY}. The wire schema the
 * model consumes is byte-for-byte identical except the added `aid` metadata and
 * the friendlier error text (which is never serialized into JSON-schema).
 *
 * No `any` / `unknown` casts: every value is narrowed by a type guard.
 */
import { z } from 'zod';

/** A directed description for one `aid` node. */
export interface AidInfo {
  /**
   * The directed noun phrase used after "expected " (e.g. "an expression",
   * "a comparison operator", "named arguments, an object of { argName: <expr> }").
   */
  label: string;
  /**
   * The bare noun for the "unknown <noun> kind" phrasing on a union no-match
   * (e.g. "expression", "query", "source"). Only meaningful for union aids.
   */
  noun?: string;
}

/**
 * The `aid → { label, noun? }` registry driving directed messages. Terse,
 * domain-specific descriptions keyed by the identifier `withAid` stamps onto
 * each generated schema node. An unregistered aid falls back to a generic
 * label (see {@link aidInfo}), so the map need not be exhaustive to stay safe.
 */
export const AID_REGISTRY: Readonly<Record<string, AidInfo>> = {
  // ── The recursive unions ──────────────────────────────────────────────────
  Expr: { label: 'an expression', noun: 'expression' },
  Query: { label: 'a query', noun: 'query' },
  Source: { label: 'a query source', noun: 'source' },

  // ── Scalars / literals ────────────────────────────────────────────────────
  ScalarValue: { label: 'a literal value: string, number, boolean, or null' },
  TypeName: { label: 'a registered Type name' },
  FieldName: { label: 'a field name' },
  FunctionName: { label: 'a registered function name' },
  FunctionArgs: { label: 'named arguments, an object of { argName: <expr> }' },
  Limit: { label: 'a number or a param' },

  // ── Operator enums ────────────────────────────────────────────────────────
  ComparisonOp: { label: 'a comparison operator' },
  BinaryOp: { label: 'an arithmetic operator' },
  UnaryOp: { label: 'a unary operator' },
  LogicalOp: { label: 'a logical connective' },
  ArrayOp: { label: 'an array operator' },

  // ── Clause enums ──────────────────────────────────────────────────────────
  OrderDir: { label: 'a sort direction (asc or desc)' },
  OrderNulls: { label: 'a null ordering (first or last)' },
  JoinType: { label: 'a join type (inner, left, right, or full)' },
  SetOpKind: { label: 'a set operation (union, intersect, or except)' },
  Join: { label: 'a JOIN clause' },

  // ── Expr kinds (surface only when a kind-pinned position gets a non-object) ─
  Expr_comparison: { label: 'a comparison' },
  Expr_binary: { label: 'an arithmetic expression' },
  Expr_unary: { label: 'a unary expression' },
  Expr_logical: { label: 'a boolean connective' },
  Expr_literal: { label: 'a literal expression' },
  Expr_param: { label: 'a bind parameter' },
  'Expr_field-ref': { label: 'a field reference { source, field }' },
  'Expr_relation-path': { label: 'a relation-path reference' },
  Expr_in: { label: 'a membership predicate' },
  Expr_between: { label: 'a range predicate' },
  'Expr_is-null': { label: 'a null test' },
  Expr_case: { label: 'a CASE expression' },
  Expr_exists: { label: 'an EXISTS predicate' },
  'Expr_array-op': { label: 'an array predicate' },
  Expr_semantic: { label: 'a semantic-similarity score' },
  'Expr_text-search': { label: 'a full-text search predicate' },
  'Expr_text-score': { label: 'a full-text relevance score' },
  'Expr_function-call': { label: 'a scalar function call' },
  'Expr_tabular-function-call': { label: 'a tabular function call' },
  Expr_aggregate: { label: 'an aggregate call' },
  Expr_window: { label: 'a window function call' },
  Expr_subquery: { label: 'a subquery' },
  Expr_output: { label: 'a SELECT output reference' },
  Expr_excluded: { label: 'an EXCLUDED reference' },
  Expr_filters: { label: 'a filter placeholder' },

  // ── Query kinds ───────────────────────────────────────────────────────────
  Query_select: { label: 'a SELECT statement' },
  Query_insert: { label: 'an INSERT statement' },
  Query_update: { label: 'an UPDATE statement' },
  Query_delete: { label: 'a DELETE statement' },
  'Query_set-operation': { label: 'a set operation' },
  Query_cte: { label: 'a WITH (CTE) statement' },
  Query_expr: { label: 'a single-expression query' },
};

/** Resolve an aid to its {@link AidInfo}, falling back to a generic label. */
export function aidInfo(aid: string): AidInfo {
  return AID_REGISTRY[aid] ?? { label: `a \`${aid}\` value` };
}

/** A plain, non-array record (so `value.kind` can be read by a guard). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A short, article-led description of the value Zod actually received, for the
 * "…, got <received>" tail. `undefined` (a MISSING value) yields no tail — the
 * message reads as a plain "expected <label>".
 */
export function describeInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'a list';
  switch (typeof input) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      // bigint / symbol / function — rare in decoded JSON; no useful tail.
      return undefined;
  }
}

/** Levenshtein edit distance between two strings (classic DP, one row). */
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
 * The nearest branch kind to a bogus `kind` by edit distance, when a plausible
 * typo (distance within a small budget). `undefined` when nothing is close
 * enough (so the caller lists the available kinds without a false suggestion).
 */
export function nearestKind(kind: string, kinds: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of kinds) {
    const d = editDistance(kind, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  // Only suggest a near miss (a genuine typo), never an unrelated word.
  return best !== undefined && bestDist <= 3 ? best : undefined;
}

/**
 * The "unknown <noun> kind `<kind>` — did you mean `<nearest>`? (available: …)"
 * message for a union no-match whose value is an object with a bogus string
 * `kind`. `undefined` when the value is not such an object (so the caller uses
 * the plain "expected <label>").
 */
function unknownKindMessage(
  input: unknown,
  kinds: readonly string[] | undefined,
  info: AidInfo,
): string | undefined {
  if (!kinds || kinds.length === 0) return undefined;
  if (!isRecord(input)) return undefined;
  const kind = input['kind'];
  if (typeof kind !== 'string') return undefined;
  const noun = info.noun ?? 'value';
  const nearest = nearestKind(kind, kinds);
  const suggestion = nearest !== undefined ? ` — did you mean \`${nearest}\`?` : '';
  return `unknown ${noun} kind \`${kind}\`${suggestion} (available: ${kinds.join(', ')})`;
}

/**
 * Render the DIRECTED message for one raw Zod issue at an aid-tagged node,
 * dispatching on the issue code:
 *  - `invalid_type` → `expected <label>[, got <received>]`;
 *  - `invalid_value` (enum / literal) → `expected <label>: <allowed>`;
 *  - `invalid_union` → the "did you mean" kind message, else `expected <label>`;
 *  - anything else → `expected <label>` (a safe, still-directed fallback).
 */
export function directedMessage(
  issue: z.core.$ZodRawIssue,
  aid: string,
  kinds: readonly string[] | undefined,
): string {
  const info = aidInfo(aid);
  switch (issue.code) {
    case 'invalid_type': {
      const got = describeInput(issue.input);
      return got !== undefined ? `expected ${info.label}, got ${got}` : `expected ${info.label}`;
    }
    case 'invalid_value': {
      // An enum / literal mismatch: `issue.values` is the allowed set (always
      // non-empty for a `z.enum` / `z.literal`), listed after the label.
      const allowed = issue.values.map((v) => String(v)).join(', ');
      return `expected ${info.label}: ${allowed}`;
    }
    case 'invalid_union': {
      return unknownKindMessage(issue.input, kinds, info) ?? `expected ${info.label}`;
    }
    default:
      return `expected ${info.label}`;
  }
}

/** A captured error map that renders the directed message for one aid node. */
function makeAidError(aid: string, kinds: readonly string[] | undefined): z.core.$ZodErrorMap {
  return (issue) => directedMessage(issue, aid, kinds);
}

/** Options for {@link withAid}. */
export interface AidOptions {
  /**
   * For a UNION node (an `.or` fold of `kind`-discriminated branches), the valid
   * discriminant kinds — drives the "unknown … kind `x` — did you mean `y`?"
   * suggestion on a no-match. Omit for non-union nodes.
   */
  kinds?: readonly string[];
}

/**
 * Tag a generated schema node with an `aid` and a directed error map.
 *
 * Attaches `.meta({ aid })` (the JSON-schema `$defs` identifier — unchanged from
 * the plain `.meta({ aid })` sites this upgrades) AND a per-schema error closure
 * that renders {@link directedMessage} off {@link AID_REGISTRY}. The closure is
 * captured (it carries its own `aid` + `kinds`), so it survives Zod's
 * clone-on-`.meta()`/`.describe()` and `z.lazy` wrapping intact.
 *
 * The returned schema is a CLONE, so chain any `.describe(...)` AFTER `withAid`.
 */
export function withAid(schema: z.ZodTypeAny, aid: string, opts: AidOptions = {}): z.ZodTypeAny {
  const cloned = schema.clone({ ...schema.def, error: makeAidError(aid, opts.kinds) });
  return cloned.meta({ aid });
}
