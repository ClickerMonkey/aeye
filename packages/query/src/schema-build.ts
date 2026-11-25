/**
 * Neutral building blocks shared by the model's query grammar (`llm/grammar.ts`)
 * and the engine descriptions (`llm/describe.ts`): which of a Type's fields a
 * reference position may name, the function selection (`selectFunctions`) and
 * the capability gate (`exprKindApplicable`).
 *
 * To avoid import cycles this module imports NOTHING from `src/llm/` or
 * `src/exprs/`: every dependency arrives by parameter (or a type-only import).
 */
import type { Registry } from './registry';
import type { Type } from './type';
import type { Field } from './field';
import type { QueryOperator } from './operator';
import type { SelectedFunctions } from './node';
import type { FunctionDef, FunctionShape, ExprKind } from './schema';

// ─── Field eligibility selectors ───────────────────────────────────────────────

/** Which of a Type's fields a reference position may name. */
export type FieldEligibility = (type: Type) => readonly Field[];

/** Eligibility: every field (a plain `field-ref` may name any field). */
export const allFields: FieldEligibility = (t) => t.fields;
/** Eligibility: only relation fields (relation-path / join hops). */
export const relationFieldsOf: FieldEligibility = (t) => t.relationFields();
/** Eligibility: only semantic-eligible fields (semantic score / query). */
export const semanticFieldsOf: FieldEligibility = (t) => t.semanticFields();
/** Eligibility: only text fields (a narrowed text-search target). */
export const textFieldsOf: FieldEligibility = (t) => t.textFields();

/**
 * WRITE-MODEL: narrow an eligibility to only the fields that ALLOW expr `kind`
 * (a field's `exprs` restriction can exclude a kind). So a paired / enumerated
 * field position never offers a field the kind is denied on.
 */
export function allowingExpr(base: FieldEligibility, kind: ExprKind): FieldEligibility {
  return (t) => base(t).filter((f) => f.allowsExpr(kind));
}

// ─── Function selection ────────────────────────────────────────────────────────

/** Resolve a per-shape `'all' | 'none' | string[]` selection against a list. */
function pickByNames(
  available: readonly FunctionDef[],
  sel: string[] | 'all' | 'none',
): FunctionDef[] {
  if (sel === 'none') return [];
  if (sel === 'all') return [...available];
  const names = new Set(sel);
  return available.filter((f) => names.has(f.name));
}

/**
 * Which functions appear in the `names` / `typed` function schemas:
 *  - `'all'`   — every registered function (default).
 *  - `'none'`  — none (function names become `z.never()`-locked).
 *  - `string[]`— exactly these function names, across all shapes.
 *  - object    — a per-shape selection (`'all'` / `'none'` / a name list),
 *                each defaulting to `'all'` when omitted.
 */
export type FunctionSelector =
  | 'all'
  | 'none'
  | string[]
  | {
      scalar?: string[] | 'all' | 'none';
      tabular?: string[] | 'all' | 'none';
      window?: string[] | 'all' | 'none';
      aggregate?: string[] | 'all' | 'none';
    };

/**
 * Resolve a `FunctionSelector` against the registry's `functionList()` into the
 * set of functions available PER SHAPE. Default (`undefined` / `'all'`) selects
 * every registered function.
 */
export function selectFunctions(registry: Registry, selector: FunctionSelector = 'all'): SelectedFunctions {
  const all = registry.functionList();
  const byShape = (shape: FunctionShape): FunctionDef[] => all.filter((f) => f.shape === shape);

  if (selector === 'all' || selector === 'none') {
    const sel = selector;
    return {
      scalar: pickByNames(byShape('scalar'), sel),
      tabular: pickByNames(byShape('tabular'), sel),
      window: pickByNames(byShape('window'), sel),
      aggregate: pickByNames(byShape('aggregate'), sel),
    };
  }
  if (Array.isArray(selector)) {
    const names = new Set(selector);
    const keep = (shape: FunctionShape): FunctionDef[] => byShape(shape).filter((f) => names.has(f.name));
    return { scalar: keep('scalar'), tabular: keep('tabular'), window: keep('window'), aggregate: keep('aggregate') };
  }
  // Per-shape object — each axis defaults to `'all'`.
  return {
    scalar: pickByNames(byShape('scalar'), selector.scalar ?? 'all'),
    tabular: pickByNames(byShape('tabular'), selector.tabular ?? 'all'),
    window: pickByNames(byShape('window'), selector.window ?? 'all'),
    aggregate: pickByNames(byShape('aggregate'), selector.aggregate ?? 'all'),
  };
}

// ─── Capability gating ─────────────────────────────────────────────────────────

/**
 * CAPABILITY GATING — whether an expr `kind` is usable at all given the
 * available Types + selected functions, INDEPENDENT of depth. A gated-out kind
 * is omitted from the Expr union entirely so the model is never offered an
 * unusable construct (e.g. `text-search` when nothing is searchable). The
 * always-usable CORE — literal / param / binary / unary / comparison / logical /
 * in / between / is-null / exists / case / field-ref / subquery — is NEVER
 * gated, so the `default` returns `true`. (A string switch over the open `kind`
 * space, hence no `never` guard.)
 */
export function exprKindApplicable(
  kind: string,
  types: readonly Type[],
  selected: SelectedFunctions,
  /**
   * The registry, for the gates that consult a REGISTERED vocabulary rather than
   * the Types.
   *
   * REQUIRED, not optional. An optional one silently answers "no operators" for
   * a caller that forgot it — a gate that fails CLOSED for the wrong reason,
   * which is indistinguishable from a deployment that has none. Both callers in
   * this package already hold the registry, and any caller outside it does too
   * (there is no way to reach an expr class list without one), so the argument
   * costs nothing and removes the silent answer.
   */
  registry: Registry,
): boolean {
  switch (kind) {
    case 'operator':
      // Gone entirely when NO registered operator could be applied to anything
      // in scope. Without this, a deployment that registers a PostGIS vocabulary
      // for one tenant carries a dead `operator` branch — with its whole
      // enum-locked glossary — in every schema generated for a tenant with no
      // geometry column.
      return registry.operatorList().some((op) => operatorReachable(op, types));
    case 'semantic':
      return types.some((t) => t.isSemantic());
    case 'text-search':
      return types.some((t) => t.isSearchable());
    case 'text-score':
      return types.some((t) => t.isSearchable());
    case 'array-op':
      // WRITE-MODEL: gone entirely when EVERY array field excludes `array-op`.
      return types.some((t) => t.fields.some((f) => f.allowsExpr('array-op')));
    case 'tabular-function-call':
      return selected.tabular.length > 0;
    case 'aggregate':
      return selected.aggregate.length > 0;
    case 'window':
      return selected.window.length > 0;
    case 'function-call':
      return selected.scalar.length > 0;
    case 'filters':
      return types.some((t) => t.fields.length > 0);
    case 'excluded':
      // Only valid inside an INSERT ON CONFLICT DO UPDATE assignment, so it is
      // kept OUT of the general Expr union and folded into that position alone
      // (see the `OnConflict.update` schema in `llm/schemas.ts`).
      return false;
    case 'output':
      // A reference to a SELECT output field by name, only valid in a SELECT's
      // groupBy / orderBy / having — so it is kept OUT of the general Expr union
      // (never offered in WHERE / expr args) and folded into those clause
      // positions alone (see the `Select` schema in `llm/schemas.ts`).
      return false;
    case 'sorter':
      // A dynamic-sort catalog, valid ONLY in a SELECT's `order` list — so it is
      // kept OUT of the general Expr union (never offered in WHERE / expr args)
      // and folded into the order position alone (see `llm/schemas.ts`).
      return false;
    default:
      return true;
  }
}

/**
 * Whether ANY operand of `operator` could be supplied from a field of the Types
 * in scope — the reachability the `operator` gate is decided on.
 *
 * ANY operand rather than EVERY, deliberately. `&&` takes two geometries and the
 * normal predicate is `shape && :box` — one column, one bind PARAM — so
 * requiring every operand to have a column behind it would gate out the exact
 * shape the operator exists for. One reachable operand is the honest reading of
 * "this vocabulary is relevant here".
 *
 * The question asked of each pair is `comparableWith`, because that is the
 * question `validateCall` will ask when the query arrives: gating on something
 * STRICTER would hide an operator a model could legitimately have used, and
 * gating on something looser would offer one every call of which is refused. An
 * `'any'` operand (which declares nothing) is reachable from any field at all,
 * which is what declaring `'any'` means.
 */
function operatorReachable(operator: QueryOperator, types: readonly Type[]): boolean {
  return operator.operands.some((operand) =>
    types.some((t) =>
      t.fields.some((f) => operand.fieldType === undefined || operand.fieldType.comparableWith(f.fieldType)),
    ),
  );
}
