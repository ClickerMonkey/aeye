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
 *    comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike"), with a
 *    trailing "— did you mean `notLike`?" when the received value is a near-miss.
 *
 * The same {@link didYouMean} suggester powers the enum tail here AND the
 * unknown-NAME diagnostics validation emits (unknown field / source / Type /
 * relation / function / arg / output) — every unknown-name error in the package
 * suggests the nearest valid name.
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

/**
 * A PROCESS-LOCAL registry for the shared-fragment `$def` ids (`Fields_*`,
 * `Args*`, `param`, `Limit`), kept OFF zod's process-GLOBAL registry.
 *
 * WHY: `.meta({ id })` registers into zod's global registry, which THROWS on any
 * duplicate id. Core's `strictify` (used to build the model wire schema) CLONES
 * every node and re-applies its `.meta()` — so a schema whose shared fragments
 * carry a global `id` collides the instant it is strictified ("ID param_g2
 * already exists in the registry"), crashing the tool-call compile before the
 * request is even sent. A `.meta({ aid })` does NOT hit the id map (zod's
 * `add()` only guards the `"id"` key), so re-registering an aid is always safe.
 *
 * The shared-fragment ids are needed ONLY so that a PLAIN `z.toJSONSchema` (which
 * factors reused instances solely by id) still emits one `$def` + `$ref`s rather
 * than inlining every copy. Routing those ids through THIS local registry (fed to
 * `z.toJSONSchema` via its `metadata` option) keeps that factoring while leaving
 * zod's global registry — and therefore `strictify` — id-free and collision-proof.
 * Core's OWN converter never needed the id: it factors by `aid` (the field-name
 * enums, `Limit`) or, for the aid-less fragments (`param`, typed `Args`), by
 * re-encountering the SAME memoized instance (an identity `$ref`), so the
 * model-facing wire schema stays factored regardless.
 */
export const sharedIdRegistry: z.core.$ZodRegistry<{ id: string }> = z.registry<{ id: string }>();

/**
 * Tag `schema` with a shared-fragment `$def` id in {@link sharedIdRegistry}
 * (NOT zod's global registry — see its docs). Returns `schema` for chaining. Call
 * it on the FINAL shared instance (after any `.describe()`), since zod strips an
 * inherited `id` from a `.describe()`/`.meta()` clone.
 */
export function withSharedId(schema: z.ZodTypeAny, id: string): z.ZodTypeAny {
  sharedIdRegistry.add(schema, { id });
  return schema;
}

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
  LiteralValue: {
    label:
      'a literal value: string, number, boolean, null, or a whole JSON document (object / array) for a json / array field',
  },
  TypeName: { label: 'a registered Type name' },
  FieldName: { label: 'a field name' },
  FunctionName: { label: 'a registered function name' },
  FunctionArgs: { label: 'named arguments, an object of { argName: <expr> }' },
  OperatorName: { label: 'a registered operator name' },
  OperatorArgs: { label: 'named operands, an object of { operandName: <expr> }' },
  OutputName: { label: 'a SELECT output field name' },
  Limit: { label: 'a number or a param' },
  Not: { label: 'a boolean `not` flag' },
  Distinct: { label: 'a boolean `distinct` flag' },
  CaseBranch: { label: 'a CASE branch, an object of { when, then }' },
  Order: { label: 'an ORDER BY term, an object of { expr, dir }' },

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
  Join: { label: 'a JOIN clause, an object of { on: { kind, … } }' },
  JoinOn: { label: "a join target: a relation crossing { kind:'relation', source, field, as } or a source def", noun: 'join target' },

  // ── Query / source building blocks (owned structural parser) ──────────────
  QueryRequest: { label: 'a query request, an object of { query: <query def> }' },
  SourceName: { label: 'a bound source name' },
  SelectField: { label: 'a select field, an object of { expr, as? }' },
  FieldValue: { label: 'a field assignment, an object of { field, value }' },
  WriteValue: { label: 'a write value: a typed value, a JSON document (object / array) for a json / array field, or an expression (use JSON null / omit to skip a field)' },
  InsertRow: { label: 'an INSERT row, a { field: value } object' },
  SetValue: { label: 'a SET record, a { field: value } object' },
  OnConflict: { label: 'an ON CONFLICT clause, an object of { fields, doNothing?, update? }' },
  CTEEntry: { label: 'a CTE binding, an object of { name, query } or { name, base, recursive }' },
  All: { label: 'a boolean `all` flag' },
  DoNothing: { label: 'a boolean `doNothing` flag' },
  SemanticQuery: { label: 'a semantic query: a string, a param, or a { source | type, field } reference' },
  Source_type: { label: 'a Type source { kind: "type", type }' },
  Source_aliased: { label: 'an aliased Type source { kind: "aliased", type, as }' },
  Source_subquery: { label: 'a subquery source { kind: "subquery", query, as }' },
  Source_function: { label: 'a table-function source { kind: "function", function, args, as }' },

  // ── Expr kinds (surface only when a kind-pinned position gets a non-object) ─
  Expr_comparison: { label: 'a comparison' },
  Expr_binary: { label: 'an arithmetic expression' },
  Expr_unary: { label: 'a unary expression' },
  Expr_logical: { label: 'a boolean connective' },
  Expr_literal: { label: 'a literal expression' },
  Expr_param: { label: 'a bind parameter' },
  'Expr_field-ref': { label: 'a field reference { source, field }' },
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
  Expr_operator: { label: 'a registered operator applied to named operands' },
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
 * `ASC` still matches `asc`, `notlike` still matches `notLike`); ties break by
 * the case-SENSITIVE distance (favoring the exact-case spelling) and then the
 * candidates' original order. Returns the surviving candidates, nearest first.
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
 * {@link didYouMean} and {@link nearestKind}.
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
 *   p.error('ref.unknown-field',
 *     `Type '${t.name}' has no field '${bad}'.${didYouMean(bad, t.fields.map(f => f.name))}`);
 *
 * TOTAL FOR A NON-STRING `input`, even though the signature says `string`, and
 * that guard is load-bearing rather than defensive noise. This composes a
 * DIAGNOSTIC, and every caller is on the road whose whole contract is that a
 * defect is REPORTED rather than raised — but the value it is handed is by
 * definition an unchecked one (that is what "unknown name" means). Measured:
 * `validateQuery` over `{kind:'text-search', query:'x'}` with no `source` reached
 * `exprs/text-search.ts`'s unknown-source diagnostic, which read `input.length`
 * for the edit budget and threw a raw `TypeError` out of this module — turning a
 * reportable problem into an uncaught crash. The DEFENSIVE parser
 * (`parseCheckedQuery`) refuses that def first, so the crash was reachable only
 * on the unchecked `validateQuery` road; the fix belongs here rather than at the
 * one call site that happened to trip it, because every other unknown-NAME
 * diagnostic in the package reads the same kind of value.
 */
export function didYouMean(
  input: string,
  candidates: readonly string[],
  opts: { max?: number } = {},
): string {
  if (typeof input !== 'string') return '';
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

/**
 * The nearest branch kind to a bogus `kind` by edit distance, when a plausible
 * typo. `undefined` when nothing is close enough (so the caller lists the
 * available kinds without a false suggestion). A thin wrapper over
 * {@link nearest} kept for the union-no-match call sites.
 */
export function nearestKind(kind: string, kinds: readonly string[]): string | undefined {
  return nearest(kind, kinds);
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
      // non-empty for a `z.enum` / `z.literal`), listed after the label. When the
      // received value is a near-miss STRING of one of them (e.g. `"notlike"` for
      // `notLike`, `"il ike"` for `ilike`), append the "did you mean" suggestion.
      const values = issue.values.map((v) => String(v));
      const allowed = values.join(', ');
      const suggestion = typeof issue.input === 'string' ? didYouMean(issue.input, values) : '';
      return `expected ${info.label}: ${allowed}${suggestion}`;
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
  /**
   * A JSON-Schema `$defs` id to stamp on SHARED, memoized fragment instances so
   * a plain `z.toJSONSchema` factors them into a single, readably-named `$def` +
   * `$ref`s instead of inlining every copy. It is registered in the process-LOCAL
   * {@link sharedIdRegistry} (NOT zod's global registry), so `strictify` never
   * re-registers it and collides. The `aid` (and its directed error map) is
   * preserved unchanged. Omit for the common inline nodes.
   */
  id?: string;
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
  const cloned = schema.clone({ ...schema.def, error: makeAidError(aid, opts.kinds) }).meta({ aid });
  // The shared-fragment `id` goes into the process-LOCAL registry (see
  // `sharedIdRegistry`) so it factors under a plain `z.toJSONSchema` WITHOUT
  // landing in zod's global registry — where `strictify`'s clone-and-re-`.meta()`
  // would collide on it. The `aid` above stays global (core factors by it).
  return opts.id !== undefined ? withSharedId(cloned, opts.id) : cloned;
}
