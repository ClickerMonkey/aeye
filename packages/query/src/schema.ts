/**
 * `@aeye/query` JSON Schema — THE central JSON-shape contract.
 *
 * This is the single source of truth for the serialized shape of every
 * meta-model node in the package: types, fields, indexes, field-types,
 * every expression kind, every query kind, plus functions and params.
 *
 * It is deliberately TYPES-ONLY (no runtime code beyond a couple of string
 * literal unions). Defining the WHOLE package's `*Def` shapes up front —
 * even the ones whose runtime classes only land in later phases — fixes the
 * contract so later phases implement classes against shapes that never move.
 *
 * Conventions:
 *  - Every polymorphic node is a discriminated union keyed by a single
 *    literal field (`kind` for field-types / exprs / queries / sources).
 *    This makes exhaustive handling compiler-checkable with zero casts.
 *  - All shapes are pure JSON (string / number / boolean / null / arrays /
 *    plain objects), so any def round-trips through `JSON.stringify`.
 *  - Optional-and-omitted is preferred over `| null`; where a field is
 *    semantically nullable in storage we say so explicitly.
 */

import type { TextCasing } from './text-casing';

// ============================================================================
// JSON PRIMITIVES
// ============================================================================

/** Any JSON value. The recursive object branch uses an index signature so
 *  arbitrary JSON trees are representable without `any`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A scalar (leaf) JSON value — the payload of a literal expression and of
 *  filter values. */
export type ScalarValue = string | number | boolean | null;

// ============================================================================
// FIELD TYPE SCHEMA
// ============================================================================

/**
 * One member of a field's CLOSED VALUE SET (see `NumberOptions.values` /
 * `TextFieldTypeDef.values`) — the stored value plus an optional human label.
 *
 * The label rides along with the value deliberately: `FieldDef` already carries
 * a `label` that `describeField` renders, so naming is not foreign to this
 * package, and splitting membership from presentation would put ONE closed set
 * in two places that can drift.
 */
export interface FieldValueDef {
  /** The stored value — one member of the closed set. */
  value: string | number;
  /** Human-facing name for this member (defaults to the value itself). */
  label?: string;
}

/**
 * Numeric option bag, shared by the `number` field type and by `money`'s
 * inner numeric configuration.
 *  - `whole`     — integral values only.
 *  - `minPlaces` / `maxPlaces` — decimal-place bounds (display / precision).
 *  - `values`    — a CLOSED SET this column may hold (see below).
 */
export interface NumberOptions {
  min?: number;
  max?: number;
  whole?: boolean;
  minPlaces?: number;
  maxPlaces?: number;
  /**
   * The closed set of values this column may hold — an enum expressed as a
   * CONSTRAINT ON the underlying scalar rather than as a separate field-type
   * `kind` (which would fork every comparison / SQL-type / value-schema path
   * for what is one extra fact). Three things depend on it and none of them are
   * reachable from outside the library: equality SELECTIVITY becomes a
   * defensible `1/n` instead of the fixed guess, the model-facing description
   * can say `one of a|b|c`, and `toValueSchema()` narrows to the members
   * instead of answering "any number". Composes with `min`/`max`.
   */
  values?: FieldValueDef[];
}

/** The `number` field type — a numeric value with the shared `NumberOptions`. */
export interface NumberFieldTypeDef extends NumberOptions {
  kind: 'number';
}

/** The `text` field type — a string with optional length / pattern / search config. */
export interface TextFieldTypeDef {
  kind: 'text';
  minLength?: number;
  maxLength?: number;
  /** Source regex (without slashes); compiled at use time. */
  pattern?: string;
  /** Eligible for embedding-based semantic similarity. */
  semantic?: boolean;
  /** Eligible for full-text search. */
  search?: boolean;
  /**
   * How textual matching / comparison on this field treats letter case, and —
   * when it is insensitive — WHO folds. Omitted ⇒ the engine's `textCasing`
   * default (`'fold'` unless the deployment says otherwise). See
   * {@link TextCasing}.
   */
  casing?: TextCasing;
  /**
   * The closed set of values this column may hold — see `NumberOptions.values`
   * for why membership is a query fact. Composes with `pattern`: a regex
   * expresses a SHAPE, a value set expresses MEMBERSHIP, and they are different
   * facts, so both may be declared.
   */
  values?: FieldValueDef[];
}

/** The `money` field type — a monetary amount plus optional currency. */
export interface MoneyFieldTypeDef {
  kind: 'money';
  /** Numeric configuration of the underlying amount. */
  number?: NumberOptions;
  /** ISO 4217 currency code (e.g. 'USD'); omit for currency-agnostic. */
  currency?: string;
}

/** The `bool` field type — a boolean value. */
export interface BoolFieldTypeDef {
  kind: 'bool';
}

/** The `relation` field type — a typed link to another Type (see `to` / `count`). */
export interface RelationFieldTypeDef {
  kind: 'relation';
  /** Name of the target Type this relation points to. */
  to: string;
  /**
   * Expected cardinality of the related rows. `1` ⇒ belongs-to / one-to-one
   * (flatten-safe); `>1` ⇒ has-many fan-out (aggregations must wrap). Used by
   * cost estimation and join planning.
   *
   * The relation field's NAME is the key for ALL purposes — there are no
   * exposed foreign-key fields. `owns` (the FK living on THIS type) is
   * INFERRED as `count === 1`; `count > 1` means the FK lives on the target.
   * NOTE this holds for a DECLARED def only: the runtime discriminator is
   * `RelationFieldType.isBelongsTo()` (`count === 1` AND no internal
   * `inverseVia`), because a registry-materialized inverse is a has-many
   * whatever its estimated `count` came out as. `inverseVia` is internal and
   * never appears in this def.
   */
  count: number;
  /**
   * If set, the Type named by `to` automatically gains a one-to-many relation
   * field with THIS name pointing back at the declaring Type. Only meaningful
   * on a belongs-to (`count === 1`) relation: it materializes the inverse
   * has-many side so the target can be queried back across the same key.
   */
  inverseRelation?: string;
}

/** A timezone policy: a fixed IANA name, `true` (store with tz), or
 *  `false` (naive / local). */
export type TimezonePolicy = string | boolean;

/** The `date` field type — a calendar date with an optional timezone policy. */
export interface DateFieldTypeDef {
  kind: 'date';
  timezone?: TimezonePolicy;
}

/** The `timestamp` field type — a date+time with an optional timezone policy. */
export interface TimestampFieldTypeDef {
  kind: 'timestamp';
  timezone?: TimezonePolicy;
}

/** The `json` field type — an arbitrary JSON value with an optional schema constraint. */
export interface JsonFieldTypeDef {
  kind: 'json';
  /** Optional JSON-Schema-shaped constraint for the stored value. */
  schema?: JsonValue;
}

/**
 * An ordered collection (SQL array / JSON array) field type.
 *  - `minItems` / `maxItems` — element-count bounds (inclusive).
 *  - `item` — the element field type. ABSENT ⇒ heterogeneous / unknown
 *    elements (any JSON value is accepted). Because `item` is itself a
 *    `FieldTypeDef`, arrays nest (e.g. `array<array<number>>`).
 */
export interface ArrayFieldTypeDef {
  kind: 'array';
  minItems?: number;
  maxItems?: number;
  item?: FieldTypeDef;
}

/** Discriminated union of all 9 field-type shapes. */
export type FieldTypeDef =
  | NumberFieldTypeDef
  | TextFieldTypeDef
  | MoneyFieldTypeDef
  | BoolFieldTypeDef
  | RelationFieldTypeDef
  | DateFieldTypeDef
  | TimestampFieldTypeDef
  | JsonFieldTypeDef
  | ArrayFieldTypeDef;

/** The set of `kind` discriminants for field types. */
export type FieldTypeKind = FieldTypeDef['kind'];

// ============================================================================
// TYPE / FIELD / INDEX SCHEMA
// ============================================================================

/**
 * A per-field restriction on which expression KINDS may TARGET the field. It can
 * only NARROW what the field's TYPE already allows (it never enables an
 * unsupported kind):
 *  - `not`  — exclude exactly these kinds (allow all others the type permits);
 *  - `only` — restrict to exactly these kinds (deny every other kind).
 * A discriminated union (exactly one of `not` / `only`) keyed by which key is
 * present. See `Field.allowsExpr`.
 */
export type FieldExprRestriction = { not: ExprKind[] } | { only: ExprKind[] };

/** One field of a Type: a name, optional label/description, its field type, and nullability. */
export interface FieldDef {
  name: string;
  /** Short human-readable label. */
  label?: string;
  /** Longer human / LLM-facing description. */
  description?: string;
  type: FieldTypeDef;
  /** Estimated average stored bytes for this field (overrides the field type's default). */
  bytes?: number;
  /**
   * Estimated milliseconds between changes to this field's data (overrides the
   * Type's rate): `0` = always changing, `-1` = never, `60000` = once a minute.
   */
  changes?: number;
  /** When true, the field may hold null / be absent. Default false. */
  nullable?: boolean;
  /** Whether the field may be supplied on INSERT. Default true. */
  insertable?: boolean;
  /** Whether the field may be assigned on UPDATE. Default true. */
  updatable?: boolean;
  /** Restrict which expr KINDS may target this field (narrows the type's set). */
  exprs?: FieldExprRestriction;
}

/**
 * One ordered part (field) of a composite index.
 *  - `expr`  — the indexed expression (commonly a single field-ref).
 *  - `count` — the distinct-row count when the index is used UP TO AND
 *    INCLUDING this part: a PREFIX cardinality, non-increasing across parts
 *    (each added part can only narrow the result further).
 */
export interface IndexPartDef {
  expr: ExprDef;
  count: number;
}

/**
 * An ordered composite index: a list of parts. Equality on a leading PREFIX of
 * the parts collapses the row estimate to that prefix's `count`. The index is
 * UNIQUE iff its LAST part's `count === 1` (the fully-specified key yields at
 * most one row).
 */
export interface IndexDef {
  exprs: IndexPartDef[];
  /** Estimated average bytes per index entry (else derived from the parts' fields). */
  bytes?: number;
}

/**
 * A named Type (the query meta-model's analogue of a table): its fields,
 * optional indexes, row/byte estimates for cost, and search/semantic eligibility.
 */
export interface TypeDef {
  name: string;
  /** Short human-readable label. */
  label?: string;
  /** Longer human / LLM-facing description. */
  description?: string;
  fields: FieldDef[];
  indexes?: IndexDef[];
  /**
   * The field (or ordered fields) that IDENTIFY a row. When present it is THE
   * answer for `Type.identityField()` / `Type.primaryKey()`: index ORDER becomes
   * irrelevant, and a unique index on any other column is just a unique index.
   *
   * Without it identity is INFERRED as "the first single-part unique index, else
   * the field named `id`" — which makes the identity of a Type depend on the
   * order its indexes happen to be listed in. A Type declaring both `id` and a
   * unique `email`, with the email index listed first, silently identifies by
   * `email`, and every relation into it then joins a stored id against an email.
   * Declaring it removes that whole class of failure.
   */
  identity?: string | string[];
  /** Estimated total row count — drives cost estimation. */
  count: number;
  /** Estimated average bytes per row (else derived as the sum of the fields' bytes). */
  bytes?: number;
  /**
   * Estimated milliseconds between changes to this Type's data: `0` = always
   * changing (the default), `-1` = never (immutable / reference data), `60000` =
   * once a minute. Drives `engine.changeInterval(query)` — a result's freshness.
   */
  changes?: number;
  /** Eligible for embedding-based semantic similarity across the type's data. */
  semantic?: boolean;
  /** Eligible for full-text search across the type's data. */
  search?: boolean;
  /** Whether rows of this Type may be INSERTed. Default true. */
  insertable?: boolean;
  /** Whether rows of this Type may be UPDATEd. Default true. */
  updatable?: boolean;
  /** Whether rows of this Type may be DELETEd. Default true. */
  deletable?: boolean;
}

// ============================================================================
// REUSABLE REFERENCE SHAPES
// ============================================================================
//
// A single family of reference shapes shared across `field-ref`, `join`,
// `semantic`, `text-search`, and `filters`. The cross-cutting NAMING RULE
// (author-confirmed) distinguishes the two key names precisely:
//
//  - `type`   — the value MUST be a REGISTERED Type name (a Type in the
//               registry). Used wherever only a real Type makes sense:
//               relation `to`, FROM `TypeSourceDef.type` / `AliasedSourceDef
//               .type`, DML `into` / `type` / `from`, function output `{type}`,
//               and `TypeFieldRef` below.
//  - `source` — the value is a BOUND name in the query's scope, which could be
//               a Type name OR a join alias / CTE name / aliased source. Used
//               wherever a previously-bound source is referenced: `field-ref`,
//               `semantic` / `text-search` / `filters`, a join's `on.source`.
//
// Reusing these shapes keeps every `{source,field}` / `{type,field}` position
// declared EXACTLY ONCE.

/** A reference to a registered Type plus one of ITS fields (both required). */
export interface TypeFieldRef {
  /** A registered Type name. */
  type: string;
  /** A field declared on that Type. */
  field: string;
}

/** A reference to a bound source (alias-capable) plus a field on it. */
export interface SourceFieldRef {
  /** A bound source name (Type name / join alias / CTE / aliased source). */
  source: string;
  /** A field on that source. */
  field: string;
}

/** A bound source plus an OPTIONAL field (omit to mean the whole source). */
export interface SourceFieldOptionalRef {
  /** A bound source name. */
  source: string;
  /** A field on that source; omit to target the source as a whole. */
  field?: string;
}

/** A bound source plus an OPTIONAL field allowlist. */
export interface SourceFieldsRef {
  /** A bound source name. */
  source: string;
  /** When set, the only fields the reference is permitted to touch. */
  fields?: string[];
}

// ============================================================================
// EXPRESSION SCHEMA
// ============================================================================
//
// One `*ExprDef` interface per expr kind named in the plan. These are JUST
// TYPES this phase — the runtime `Expr` classes (and the `canonicalize`
// digest) arrive in Phase 2 and will be built against exactly these shapes.

/** Binary arithmetic operators. */
export type BinaryOp = '+' | '-' | '*' | '/' | '%';
/** Unary arithmetic operators. */
export type UnaryOp = '-' | '+';
/** Scalar comparison operators. */
export type ComparisonOp =
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | 'like'
  | 'notLike'
  | 'ilike';
/** Boolean connectives. `not` takes exactly one operand. */
export type LogicalOp = 'and' | 'or' | 'not';

/**
 * A literal constant VALUE — a scalar, or a whole JSON document (an object /
 * array) for a `json` / `array` field.
 *
 * The non-scalar half exists because a WRITE CELL had no way to carry one: a
 * `json` column could not be inserted or updated at all (a raw document was
 * refused by the write parser, no expression could carry one, and the `param`
 * route bound SQL `NULL` — see 0.6.1's A9). A non-scalar literal is bound as a
 * single parameter through `Dialect.jsonValue`, never string-interpolated.
 */
export interface LiteralExprDef {
  kind: 'literal';
  value: JsonValue;
}

/**
 * A direct field reference: `<source>.<field>`. Reuses `SourceFieldRef` — the
 * canonical "bound source + its field" shape.
 */
export type FieldRefExprDef = { kind: 'field-ref' } & SourceFieldRef;

/** A named bind parameter whose type is inferred from its usage context. */
export interface ParamExprDef {
  kind: 'param';
  name: string;
}

/** A binary arithmetic expression: `left <op> right`. */
export interface BinaryExprDef {
  kind: 'binary';
  op: BinaryOp;
  left: ExprDef;
  right: ExprDef;
}

/** A unary arithmetic expression: `<op> operand` (e.g. negation). */
export interface UnaryExprDef {
  kind: 'unary';
  op: UnaryOp;
  operand: ExprDef;
}

/** A scalar comparison expression: `left <op> right` yielding a boolean. */
export interface ComparisonExprDef {
  kind: 'comparison';
  op: ComparisonOp;
  left: ExprDef;
  right: ExprDef;
}

/** Boolean connective. For `not`, `operands` holds exactly one element. */
export interface LogicalExprDef {
  kind: 'logical';
  op: LogicalOp;
  operands: ExprDef[];
}

/** `value IN (...)` — list of exprs or a subquery. */
export interface InExprDef {
  kind: 'in';
  value: ExprDef;
  /** Either an explicit value list or a subquery yielding one field. */
  in: ExprDef[] | QueryDef;
  /** Negate to `NOT IN`. */
  not?: boolean;
}

/** `value BETWEEN lower AND upper`. */
export interface BetweenExprDef {
  kind: 'between';
  value: ExprDef;
  lower: ExprDef;
  upper: ExprDef;
  not?: boolean;
}

/** `value IS [NOT] NULL`. */
export interface IsNullExprDef {
  kind: 'is-null';
  value: ExprDef;
  not?: boolean;
}

/** `[NOT] EXISTS (subquery)`. */
export interface ExistsExprDef {
  kind: 'exists';
  query: QueryDef;
  not?: boolean;
}

/** The array predicate operators (see `ArrayOpExprDef`). */
export type ArrayOp =
  | 'contains'
  | 'containsAny'
  | 'containsAll'
  | 'isEmpty'
  | 'notEmpty';

/**
 * A predicate over an array-valued `target`:
 *  - `contains`     — `target` contains the single element `value`.
 *  - `containsAny`  — `target` overlaps any element of the `value` list.
 *  - `containsAll`  — `target` contains every element of the `value` list.
 *  - `isEmpty`      — `target` has no elements (takes no `value`).
 *  - `notEmpty`     — `target` has at least one element (takes no `value`).
 *
 * `value` is a single `ExprDef` for `contains`, an `ExprDef[]` for
 * `containsAny` / `containsAll`, and OMITTED for `isEmpty` / `notEmpty`.
 */
export interface ArrayOpExprDef {
  kind: 'array-op';
  op: ArrayOp;
  target: ExprDef;
  value?: ExprDef | ExprDef[];
}

/** One `WHEN ... THEN ...` branch of a `CASE` expression. */
export interface CaseBranchDef {
  when: ExprDef;
  then: ExprDef;
}

/** `CASE WHEN ... THEN ... [ELSE ...] END`. */
export interface CaseExprDef {
  kind: 'case';
  branches: CaseBranchDef[];
  else?: ExprDef;
}

/**
 * An aggregate function call, dispatched through the registry like every other
 * function shape. `function` names a registered AGGREGATE-shaped function and
 * `args` supplies its arguments BY PARAMETER NAME (e.g. the builtin aggregates
 * declare a single `value` param). The `count(*)` form is `function: 'count'`
 * with an EMPTY `args` object — there is no `'*'` sentinel; count over rows is
 * simply count with no `value` argument.
 */
export interface AggregateExprDef {
  kind: 'aggregate';
  /** Registered aggregate function name. */
  function: string;
  /** Arguments keyed by declared parameter name (empty for `count(*)`). */
  args: Record<string, ExprDef>;
  distinct?: boolean;
}

/** One ORDER BY term: an expression, a direction, and an optional nulls placement. */
export interface OrderDef {
  expr: ExprDef;
  dir: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

/** One `{ sort, dir }` entry of a sorter's `defaultSort` (a named sort + direction). */
export interface SortEntryDef {
  /** A declared sort NAME (a key of the sorter's `sorts`). */
  sort: string;
  /** Sort direction for this key. */
  dir: 'asc' | 'desc';
}

/**
 * One entry of a caller's EXECUTION-TIME sort SELECTION — the dynamic-sort
 * analogue of a bound param / filter value. `sort` names one of a `sorter`
 * placeholder's declared `sorts`; `dir` (defaulting to `'asc'`) is the direction
 * to apply. The caller supplies an ORDERED list (multi-key priority) via
 * `RuntimeOptions.sort` / `engine.toSQL({ sort })`; the LLM never authors it.
 */
export interface SortSelectionDef {
  /** A declared sort name (a key of a `sorter`'s `sorts`). */
  sort: string;
  /** Sort direction; defaults to `'asc'` when omitted. */
  dir?: 'asc' | 'desc';
}

/**
 * A window function over a partition / order. `function` names a registered
 * WINDOW-shaped function (e.g. `rowNumber`, `rank`, `lag`) — or an
 * AGGREGATE-shaped function used as a windowed aggregate (`sum(...) OVER (...)`)
 * — and `args` supplies its arguments BY PARAMETER NAME.
 */
export interface WindowExprDef {
  kind: 'window';
  /** Registered window (or aggregate) function name. */
  function: string;
  /** Arguments keyed by declared parameter name. */
  args: Record<string, ExprDef>;
  partitionBy?: ExprDef[];
  orderBy?: OrderDef[];
}

/** A scalar function call. `args` are keyed by declared parameter name. */
export interface FunctionCallExprDef {
  kind: 'function-call';
  function: string;
  /** Arguments keyed by declared parameter name. */
  args: Record<string, ExprDef>;
}

/**
 * A type-valued function call (produces rows; usable as a source). `args` are
 * keyed by declared parameter name.
 */
export interface TabularFunctionCallExprDef {
  kind: 'tabular-function-call';
  function: string;
  /** Arguments keyed by declared parameter name. */
  args: Record<string, ExprDef>;
}

/**
 * The query a `semantic` expr compares the row against:
 *  - a literal natural-language `string`;
 *  - a `param` whose bound value supplies the text;
 *  - a `SourceFieldRef` (`{ source, field }`) pointing at ANOTHER BOUND source +
 *    semantic field whose embedding becomes the query vector — the primary
 *    cross-source PAIRING form (both sides must be bound in the query scope); or
 *  - a `TypeFieldRef` (`{ type, field }`) naming a semantic Type + field; it
 *    resolves to the SINGLE bound source of that Type in scope (unbound ⇒
 *    `semantic.query-unbound`, bound more than once ⇒ `semantic.query-ambiguous`,
 *    which steers the author to the unambiguous `{ source }` form).
 */
export type SemanticQueryDef = string | ParamExprDef | SourceFieldRef | TypeFieldRef;

/**
 * Semantic-similarity score of a bound source's row against a query (returns a
 * number, roughly 1 = most similar). Requires an embedder. `source` is the
 * bound source whose row is scored; `field` (optional) narrows the score to a
 * single semantic field, otherwise the whole source's embedding is used.
 */
export type SemanticExprDef = { kind: 'semantic' } & SourceFieldOptionalRef & {
  /** Text / param / another Type+field whose embedding is the query vector. */
  query: SemanticQueryDef;
};

/**
 * Full-text search predicate over a bound source (optionally one field). The
 * query is a literal string or a `param` whose value supplies the search text.
 */
export type TextSearchExprDef = { kind: 'text-search' } & SourceFieldOptionalRef & {
  /** The search query: a literal string or a bound param. */
  query: string | ParamExprDef;
};

/**
 * NUMERIC full-text relevance SCORE of a bound source (optionally one field)
 * against a query — the ranking counterpart of the `text-search` predicate.
 * Resolves to a non-null number (usable in SELECT + ORDER BY, so "top N by text
 * relevance" works). `query` is a literal string or a `param`. Postgres emits
 * `ts_rank`; the base (ANSI) dialect degrades to a numeric 0/1 match.
 */
export type TextScoreExprDef = { kind: 'text-score' } & SourceFieldOptionalRef & {
  /** The search query: a literal string or a bound param. */
  query: string | ParamExprDef;
};

/**
 * A structured filter placeholder bound to a source, with an optional `fields`
 * allowlist. The clauses themselves are NOT authored here (the LLM never emits
 * them): they are supplied at execution time and validated against this
 * source + allowlist. Reuses `SourceFieldsRef`.
 */
export type FiltersExprDef = { kind: 'filters' } & SourceFieldsRef;

/** A subquery used in value position (typically scalar / single-field). */
export interface SubqueryExprDef {
  kind: 'subquery';
  query: QueryDef;
}

/**
 * A reference to the PROPOSED (excluded) row inside an `INSERT … ON CONFLICT DO
 * UPDATE`. `field` names a column of the row that WOULD have been inserted; SQL
 * emits `EXCLUDED."field"` and the runtime reads the proposed value. Only valid
 * inside an on-conflict update assignment (the `excluded` source is bound there).
 */
export interface ExcludedExprDef {
  kind: 'excluded';
  field: string;
}

/**
 * A reference to a SELECT OUTPUT FIELD by its name — either the field's
 * explicit `as`, or the natural derived name (see `fieldNameOf`: a field-ref's
 * field, an aggregate's function name, else `col<i>`). It lets a SELECT's
 * `groupBy` / `orderBy` / `having` reference a
 * projected output BY NAME instead of repeating its whole expression — smaller
 * queries and fewer GROUP BY / ORDER BY mismatches.
 *
 * It EXPANDS to (delegates to) the referenced select item's expression: SQL
 * emits the target's SQL and the runtime re-evaluates the target expr, so a
 * group key re-computes over the source row and an ORDER BY / HAVING ref
 * re-computes over the group (including an aggregate target). It is ONLY valid
 * in those clause positions — used in WHERE / a JOIN `on` / a general expr
 * argument (where no outputs are bound) it fails validation.
 */
export interface OutputRefExprDef {
  kind: 'output';
  /** The referenced output field's name (a select item's `as` or natural name). */
  name: string;
}

/**
 * A DYNAMIC-SORT catalog placeholder, valid ONLY inside a SELECT's `order` list —
 * the ORDER BY analogue of the `filters` placeholder. The query author (or LLM)
 * declares a CATALOG of named, sortable expressions (`sorts`); the CALLER picks
 * which of them to sort by — and in what direction / priority — at EXECUTION time
 * via `RuntimeOptions.sort` / `engine.toSQL({ sort })`, so an end-user can re-sort
 * a live result. A `sorts` VALUE may be any `ExprDef`, INCLUDING an `output`
 * reference (sort by a select item without restating its expr).
 *
 * At execute / emit time the placeholder EXPANDS into concrete ORDER BY terms:
 * each caller-selected `{ sort, dir }` looks up `sorts[sort]` and contributes
 * `(that expr, dir)`. With NO caller selection it falls back to `defaultSort`
 * (each `{ sort, dir }` → `sorts[sort]`); with neither it contributes no terms.
 * A selected `sort` name absent from `sorts` is a loud runtime error.
 */
export interface SorterDef {
  kind: 'sorter';
  /** The catalog of named sortable expressions (sort name → expr). Non-empty. */
  sorts: Record<string, ExprDef>;
  /** The default multi-key sort (each `{ sort, dir }`) applied when the caller selects none. */
  defaultSort?: SortEntryDef[];
}

/** Discriminated union of every expression shape. */
/**
 * An ARG PLACEHOLDER — used ONLY inside an aggregate `FunctionDef`'s un-aggregate
 * TEMPLATE (see `FunctionDef.unaggregate`) to mark where the aggregate call's
 * argument `name` is substituted. It is part of the `ExprDef` union so templates
 * type-check, but it has NO registered Expr class: it is substituted to the call's
 * real arg BEFORE the template is ever parsed / validated / emitted, so it never
 * reaches a live query, the parser, or the LLM schema.
 */
export interface ArgExprDef {
  kind: 'arg';
  /** The aggregate parameter name this placeholder stands in for (e.g. `value`). */
  name: string;
}

export type ExprDef =
  | LiteralExprDef
  | OutputRefExprDef
  | SorterDef
  | ArgExprDef
  | FieldRefExprDef
  | ParamExprDef
  | BinaryExprDef
  | UnaryExprDef
  | ComparisonExprDef
  | LogicalExprDef
  | InExprDef
  | BetweenExprDef
  | IsNullExprDef
  | ExistsExprDef
  | ArrayOpExprDef
  | CaseExprDef
  | AggregateExprDef
  | WindowExprDef
  | FunctionCallExprDef
  | TabularFunctionCallExprDef
  | SemanticExprDef
  | TextSearchExprDef
  | TextScoreExprDef
  | FiltersExprDef
  | SubqueryExprDef
  | ExcludedExprDef;

/** The set of `kind` discriminants for expressions. */
export type ExprKind = ExprDef['kind'];

// ============================================================================
// QUERY STRUCTURE SCHEMA
// ============================================================================
//
// Modelled on cletus's `dba.ts` Query/Statement union, but RELATION-JOIN
// based: a `JoinDef` references a relation field path plus an optional
// extra predicate, never an explicit ON clause.

/**
 * A FROM / join source: a type (Type), an explicitly-aliased type, or a
 * subquery.
 *
 * The model is "reference everything by its TYPE NAME": the plain `type`
 * source is bound under its type name and is NOT aliasable — this removes the
 * common authoring/LLM bug where a `FROM { type:'order', as:'o' }` is then
 * referenced by `field-ref.source:'order'` (or vice-versa). When you genuinely
 * need a custom name — two instances of the same type (a self-join), or to
 * disambiguate a collision — use the explicit `aliased` escape hatch.
 */
export type SourceDef = TypeSourceDef | AliasedSourceDef | SubquerySourceDef | FunctionSourceDef;

/** A plain Type source: `FROM <type>`, bound (non-aliasable) under its Type name. */
export interface TypeSourceDef {
  kind: 'type';
  /** Name of the Type to read from. The source is bound under THIS name. */
  type: string;
}

/**
 * An explicitly-aliased type source — the discouraged escape hatch. Bound
 * under `as` (which becomes the source name field-refs use), reading the Type
 * named `type`. Use only when the plain `type` source can't express the query:
 * a self-join (the same type twice) or breaking a `source.duplicate` collision.
 */
export interface AliasedSourceDef {
  kind: 'aliased';
  /** Name of the Type to read from. */
  type: string;
  /** The source name this instance is bound under (field-refs use this). */
  as: string;
}

/** A derived (subquery) source: `FROM (<query>) AS <as>`. */
export interface SubquerySourceDef {
  kind: 'subquery';
  query: QueryDef;
  /** Required alias for the derived source. */
  as: string;
}

/**
 * A TABLE-VALUED FUNCTION source: `FROM <function>(args) AS <as>`. `function`
 * names a registered TABULAR-shaped function whose output Type defines the
 * source's columns; `args` supplies its arguments BY DECLARED PARAMETER NAME.
 * The runtime invokes the function's registered `tabular` implementation for
 * rows; SQL emits the `<function>(args) AS <alias>` form.
 */
export interface FunctionSourceDef {
  kind: 'function';
  /** Name of a registered tabular function. */
  function: string;
  /** Arguments keyed by declared parameter name. */
  args: Record<string, ExprDef>;
  /** Required alias the produced rows bind under. */
  as: string;
}

/**
 * A RELATION join `on`: cross a bound source's belongs-to/has-many relation
 * FIELD into its target, bound under the REQUIRED alias `as`. The join key is
 * synthesized from the relation (never written); `as` is always present and
 * must be unique in the query. Multi-hop crossings are expressed as CHAINED
 * relation joins (each hop names the previous hop's `as` as its `source`).
 */
export interface RelationJoinOnDef {
  kind: 'relation';
  /** The bound source to join FROM. */
  source: string;
  /** The relation field on `source` to cross. */
  field: string;
  /** REQUIRED alias the joined target binds under (field-refs use this). */
  as: string;
}

/**
 * A join's `on`: EITHER a `relation` crossing (key synthesized from the
 * relation field) OR a MANUAL join that adds a source directly — a Type, an
 * aliased Type, a subquery, or a table-valued function — with `JoinDef.and` as
 * the explicit ON condition. The added source binds under: the Type name (for
 * `type`), or its `as` (for `relation` / `aliased` / `subquery` / `function`).
 */
export type JoinOnDef =
  | RelationJoinOnDef
  | TypeSourceDef
  | AliasedSourceDef
  | SubquerySourceDef
  | FunctionSourceDef;

/**
 * A join over another source. `on` is EITHER a `relation` crossing (the join
 * key is synthesized from the relation field, LEFT by default — reproducing a
 * belongs-to/has-many traversal) OR a source-def MANUAL join (`type` /
 * `aliased` / `subquery` / `function`) whose ON condition is `and`. For a
 * `relation` `on`, `and` is an OPTIONAL extra predicate ANDed with the
 * synthesized key; for a source-def `on`, `and` IS the join condition.
 */
export interface JoinDef {
  /** The join target: a relation crossing or a manually-joined source. */
  on: JoinOnDef;
  /** For `relation`: an extra predicate ANDed with the synthesized key. For a
   *  source-def `on`: the join's ON condition. */
  and?: ExprDef;
  /** Join type; defaults to `left`. (Renamed from `type` to free that key
   *  for the Type-name naming rule.) */
  joinType?: 'inner' | 'left' | 'right' | 'full';
}

/** A selected output field. */
export interface SelectFieldDef {
  expr: ExprDef;
  /** Output alias; required when the expr has no natural name. */
  as?: string;
}

/**
 * A single field's WRITE value on INSERT / UPDATE: EITHER a raw typed value (a
 * value of the field's own `FieldType.toValueSchema()`) OR a full `ExprDef`.
 * Both are pure JSON, so a raw value and an expression are told apart by SHAPE:
 * a non-null object carrying a string `kind` discriminant is an `ExprDef`;
 * anything else (a scalar / array / plain object) is a raw value.
 *
 * NULL SEMANTICS (OpenAI-safe — CRITICAL): an ABSENT key OR a JSON `null` value
 * means OMIT the field (leave it to its backing default / unset). To EXPLICITLY
 * set SQL NULL you MUST use a literal-null expr `{ kind:'literal', value:null }`.
 * A bare JSON `null` is NEVER "set NULL" — OpenAI models emit `null` for omitted
 * fields and cannot distinguish omit from null, so the parser drops it.
 */
export type WriteValueDef = JsonValue | ExprDef;

/**
 * One INSERT row: a map of field name → its {@link WriteValueDef}. Absent keys
 * (and JSON-`null`-valued keys) are OMITTED per {@link WriteValueDef}'s null
 * semantics. Multi-row INSERTs require HOMOGENEOUS keys across every row.
 */
export interface InsertRowDef {
  [field: string]: WriteValueDef;
}

/**
 * UPDATE `SET` (and ON CONFLICT DO UPDATE) assignments, keyed by field name —
 * `{ [field]: WriteValueDef }`. Absent / JSON-`null`-valued keys are OMITTED
 * (see {@link WriteValueDef}); a literal-null expr sets SQL NULL.
 */
export interface SetDef {
  [field: string]: WriteValueDef;
}

/**
 * The `ON CONFLICT` clause of an INSERT: the conflict-target `fields`, plus
 * either `doNothing` or an `update` assignment record (DO UPDATE SET …).
 */
export interface OnConflictDef {
  /** Conflict-target columns (the unique key being upserted on). */
  fields: string[];
  /** DO NOTHING on conflict. */
  doNothing?: boolean;
  /** DO UPDATE SET assignments, keyed by field (may reference the `excluded` row). */
  update?: SetDef;
}

/** A `SELECT` statement: projected fields, source, joins, filters, grouping, ordering, paging. */
export interface SelectDef {
  kind: 'select';
  distinct?: boolean;
  fields: SelectFieldDef[];
  from: SourceDef;
  joins?: JoinDef[];
  /** WHERE conditions, ANDed together. */
  where?: ExprDef[];
  groupBy?: ExprDef[];
  /** HAVING conditions, ANDed together. */
  having?: ExprDef[];
  /**
   * ORDER BY: a list whose entries are EITHER a normal `{ expr, dir, nulls? }`
   * term OR a `sorter` placeholder (`{ kind:'sorter', … }`) whose concrete terms
   * are supplied at execution time (see {@link SorterDef}).
   */
  order?: (OrderDef | SorterDef)[];
  /** Row cap — a literal count, or a named param (see the auto-paginate
   *  transform, which binds pagination to params for reuse). */
  limit?: number | ParamExprDef;
  /** Row skip — a literal count, or a named param. */
  offset?: number | ParamExprDef;
  // NOTE: `includeTotal` is an EXECUTION-time option (see `RuntimeOptions
  // .includeTotal` / `engine.toSQL`), NOT a build-time SELECT field.
}

/** An `INSERT` statement: target Type, row records or a select, plus optional RETURNING / ON CONFLICT. */
export interface InsertDef {
  kind: 'insert';
  /** Target Type name. The statement references the target by THIS name. */
  into: string;
  /** Row records (each a keyed `{ field: WriteValueDef }` map), OR a select. */
  rows?: InsertRowDef[];
  select?: QueryDef;
  returning?: SelectFieldDef[];
  onConflict?: OnConflictDef;
}

/** An `UPDATE` statement: target Type, keyed SET assignments, optional joins / WHERE / RETURNING. */
export interface UpdateDef {
  kind: 'update';
  /** Target Type name. The statement references the target by THIS name. */
  type: string;
  /** SET assignments, keyed by field name (see {@link SetDef}). */
  set: SetDef;
  joins?: JoinDef[];
  where?: ExprDef[];
  returning?: SelectFieldDef[];
}

/** A `DELETE` statement: target Type, optional joins / WHERE / RETURNING. */
export interface DeleteDef {
  kind: 'delete';
  /** Target Type name. The statement references the target by THIS name. */
  from: string;
  joins?: JoinDef[];
  where?: ExprDef[];
  returning?: SelectFieldDef[];
}

/** A set operation (`UNION` / `INTERSECT` / `EXCEPT`) over two queries, with set-level order/limit/offset. */
export interface SetOperationDef {
  kind: 'union' | 'intersect' | 'except';
  left: QueryDef;
  right: QueryDef;
  /** Keep duplicates (UNION ALL, etc.). */
  all?: boolean;
  /**
   * SET-LEVEL ordering applied AFTER the set operation, over the COMBINED rows.
   * Each term's `expr` references an OUTPUT COLUMN (a `field-ref` whose `field`
   * is the output column name — the `source` is ignored; a set operation has no
   * table to qualify). Emitted as a trailing `ORDER BY` on the whole set.
   */
  order?: OrderDef[];
  /** SET-LEVEL row cap applied after the set op — a literal count or a param. */
  limit?: number | ParamExprDef;
  /** SET-LEVEL row skip applied after the set op — a literal count or a param. */
  offset?: number | ParamExprDef;
}

/** A plain (non-recursive) common-table-expression entry. */
export interface CTEDef {
  name: string;
  query: QueryDef;
}

/**
 * A RECURSIVE common-table-expression entry: a `base` seed query UNION-ed with
 * a `recursive` arm that reads the CTE's own accumulated rows until a fixpoint
 * (iteration-capped). Structurally discriminated from `CTEDef` by the presence
 * of `base` + `recursive` (vs `query`).
 */
export interface CTERecursiveDef {
  name: string;
  /** The seed (anchor) query. */
  base: QueryDef;
  /** The recursive arm (reads the CTE's own rows). */
  recursive: QueryDef;
}

/** A `WITH` statement: a list of (possibly recursive) CTE entries plus the `final` query that consumes them. */
export interface CTEStatementDef {
  kind: 'cte';
  ctes: (CTEDef | CTERecursiveDef)[];
  /** The final statement that consumes the CTEs. */
  final: QueryDef;
}

/** A query that is a single expression (e.g. a scalar computation). */
export interface ExprQueryDef {
  kind: 'expr';
  expr: ExprDef;
}

/** Discriminated union of every query shape. */
export type QueryDef =
  | SelectDef
  | InsertDef
  | UpdateDef
  | DeleteDef
  | SetOperationDef
  | CTEStatementDef
  | ExprQueryDef;

/** The set of `kind` discriminants for queries. */
export type QueryKind = QueryDef['kind'];

// ============================================================================
// FUNCTION / PARAM SCHEMA
// ============================================================================

/** What category of function this is (drives output resolution + SQL emit). */
export type FunctionShape = 'scalar' | 'tabular' | 'window' | 'aggregate';

/**
 * How two values of one AGGREGATE combine into the value over the UNION of the
 * groups that produced them — the fact a consumer needs to fold a tail of groups
 * into a residual ("Other" slice / row / column) without re-running the query.
 *
 * For `f` applied to DISJOINT groups `A` and `B`, the declared operation `⊕` must
 * satisfy `f(A ∪ B) = f(A) ⊕ f(B)` for every partition — a claim about the
 * function, not about one dataset:
 *  - `'sum'` — additive (`count`, `sum`, `countIf`).
 *  - `'min'` / `'max'` — extremal (`min`, `max`).
 *  - `'and'` / `'or'` — boolean folds (`boolAnd`, `boolOr`).
 *  - `'none'` — NOT recoverable from the per-group values alone, and the default
 *    for any function that does not declare otherwise. `avg` is the canonical
 *    case: the merge needs each group's WEIGHT (its row count), which the result
 *    does not carry — adding the means or averaging them are both simply wrong.
 *    `stddev` / `variance` need the same; `stringAgg` / `arrayAgg` depend on a
 *    separator / ordering a pair of values cannot supply.
 *
 * `'sum'` is the one arm DISTINCT invalidates — de-duplication is global, so two
 * `count(DISTINCT x)` values cannot be added — while `min`/`max`/`and`/`or` are
 * idempotent and merge identically with or without it. A consumer should read the
 * already-resolved answer on `ComputedResolved.aggregateMerge` rather than
 * re-derive that rule (see `mergeOfAggregateCall`).
 */
export type AggregateMerge = 'sum' | 'min' | 'max' | 'and' | 'or' | 'none';

/** A declared function parameter. `type: 'any'` accepts any field type. */
export interface FunctionParamDef {
  name: string;
  type: FieldTypeDef | 'any';
  optional?: boolean;
}

/**
 * Serializable description of a callable. The runtime `FunctionDef` class
 * (later phase) may also carry an `output`-resolver function and a `run`
 * implementation; the JSON shape captures the declarable parts.
 */
export interface FunctionDef {
  name: string;
  shape: FunctionShape;
  /**
   * Optional terse, LLM-facing usage note (what it does / arg meaning / any
   * gotcha) — the canonical concise doc surfaced to a model choosing functions.
   */
  instructions?: string;
  /**
   * Optional WORKED examples — each a RAW JSON string of an expr fragment (or a
   * full query) that CALLS this function, teaching its SHAPE with illustrative
   * generic source/field names. Surfaced (capped) under the function's signature
   * by `describeEngine`. Carried verbatim by `QueryFunction` (`from` / `toJSON`).
   */
  examples?: readonly string[];
  params: FunctionParamDef[];
  /**
   * Declared output: a concrete field type, a reference to a Type (for
   * tabular functions), or `'inferred'` when computed from the args at
   * resolve time.
   */
  output: FieldTypeDef | { type: string } | 'inferred';
  /** Optional SQL template / function name for emission. */
  sql?: string;
  /**
   * DECLARED-PARAMETER INDICES whose argument must be emitted as an INLINE SQL
   * literal (a bare field token) rather than a bound parameter. Used by the
   * date-field selectors (`datePart` / `dateAdd` / `dateDiff` / `dateTrunc`)
   * whose `field` argument becomes an `EXTRACT`/`date_part` field name — a value
   * the dialect must splice literally, never bind as `$1`. Validated (the arg
   * must be a literal from the allowed date-field set) by `FunctionCallExpr`.
   */
  rawArgs?: readonly number[];
  /**
   * AGGREGATE UN-AGGREGATION template (serializable, so it survives the wire): the
   * ROW-LEVEL `ExprDef` this aggregate summarizes, with `{ kind:'arg', name }`
   * placeholders (see {@link ArgExprDef}) for the call's arguments. A drilled
   * query substitutes each aggregate call's args into this template to recover the
   * underlying expression — `sum(o.total)` → `o.total` (template `{kind:'arg',
   * name:'value'}`); `count(v)` → `CASE WHEN v IS NULL THEN 0 ELSE 1 END`. Absent
   * ⇒ this aggregate cannot be un-aggregated. Used for the ARG-PRESENT form.
   */
  unaggregate?: ExprDef;
  /**
   * The un-aggregate template for the ARG-LESS form of the aggregate (`count(*)`),
   * chosen by `AggregateExpr.unaggregate` when the call has no arguments — e.g.
   * `count(*)` → `{ kind:'literal', value:1 }`. (A `count(*)` un-aggregates to the
   * constant 1 each row contributes; being field-less, it is then dropped from a
   * drilled select/order.)
   */
  unaggregateEmpty?: ExprDef;
  /**
   * AGGREGATE MERGE semantics — how two of this aggregate's per-group values
   * combine into the value over the union of those groups ({@link AggregateMerge}).
   * Declarable ONLY on an `aggregate`-shaped function — resolving one that is
   * not THROWS (`QueryFunction.from`, exactly as an unknown output Type does),
   * because the notion is meaningless for a scalar / window / tabular call and a
   * silently ignored key is worse than a loud one.
   * Absent ⇒ `'none'` — an aggregate whose author did not say is treated as
   * un-mergeable, so a consumer folding groups fails SAFE rather than inventing
   * arithmetic. Surfaced per CALL (DISTINCT accounted for) on
   * `ComputedResolved.aggregateMerge`.
   */
  merge?: AggregateMerge;
  /** Intrinsic per-call cost `{ rows, bytes }` this function adds beyond its args. */
  cost?: { rows: number; bytes: number };
  /**
   * Ms between changes to this function's RESULT independent of the data:
   * `0` = always (`now()`), `-1` = pure / never (default), `86400000` = daily
   * (`currentDate()`). Folded into `engine.changeInterval`.
   */
  changes?: number;
  /** Type names this function internally READS (folded into cost / references / freshness). */
  references?: readonly string[];
}

/** A resolved bind parameter — name plus the field type inferred for it. */
export interface ParamDef {
  name: string;
  type: FieldTypeDef;
}
