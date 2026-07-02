/**
 * Filter-operator model — algorithm "(c) filters → BoolExpr + per-FieldType
 * operator catalog" of the plan.
 *
 * A `FilterOp` is one operator an author can apply to a field in a structured
 * filter set (`FiltersExpr`). Each op knows:
 *  - its `arity` (how many operand values it consumes), used to validate a
 *    clause's value shape;
 *  - how to `compile` itself to an EXISTING boolean `Expr` (comparison / in /
 *    between / is-null, plus `search` → `TextSearchExpr` and `similar` →
 *    a `SemanticExpr` threshold), so cost + SQL + evaluation all thread
 *    through the normal expr machinery — `FilterOp` adds no new runtime path;
 *  - its per-op operand `valueSchema(fieldType)`, the Zod the filter-builder
 *    UI / strict schema uses to validate the clause's value(s).
 *
 * IMPORTANT (module-load discipline): `compile` builds the target expression
 * as a plain `ExprDef` and reconstructs it via `registry.parseExpr`, rather
 * than importing the concrete `Expr` classes. The field types delegate their
 * `filterOps()` here, so importing the concrete exprs would create a load-time
 * cycle (`field-types → filters → exprs → field-types`) that breaks class
 * extension. Going through the registry keeps this module free of any concrete
 * expr import.
 *
 * `catalogForFieldType(ft)` returns the exact op set the plan lists per kind.
 * Because an op's compilation is independent of the field's category (an `eq`
 * is always `field = value`), every op is a single shared singleton in
 * `FILTER_OPS`; the catalog just selects names, and `valueSchema` takes the
 * field type so the SAME singleton produces the right operand schema for a
 * number vs a text field.
 */
import { z } from 'zod';
import type { ComparisonOp, ExprDef, FilterClauseDef, ScalarValue } from './schema';
import type { FieldType, ScalarKind } from './field-type';
import type { Registry } from './registry';
import { BoolExpr, type Expr } from './expr';
import { TextFieldType, ArrayFieldType, jsonValueSchema } from './field-types/index';

/** Similarity score above which a `similar` clause counts as a match. */
export const SIMILARITY_THRESHOLD = 0.5;

/**
 * One filter operator. `compile` lowers a `(field, values)` clause to an
 * existing boolean expr; `valueSchema` schemas the clause's operand(s).
 */
export interface FilterOp {
  /** The operator name (the `op` an author writes in a `FilterClauseDef`). */
  readonly op: string;
  /**
   * How many operand values the op takes:
   *  - `unary`  — none (e.g. `isNull`);
   *  - `binary` — exactly one (e.g. `eq`, `contains`);
   *  - `list`   — a value array (e.g. `in`);
   *  - `range`  — exactly two (e.g. `between`).
   */
  readonly arity: 'unary' | 'binary' | 'list' | 'range';
  /** Lower this op to a concrete boolean expr over `fieldExpr` + `values`. */
  compile(fieldExpr: Expr, values: readonly Expr[], registry: Registry): BoolExpr;
  /** The Zod schema for this op's operand value(s) on a `fieldType` field. */
  valueSchema(fieldType: FieldType): z.ZodTypeAny;
}

// ─── operand helpers (work over ExprDef JSON, no concrete-expr imports) ───────

/** The `i`th value as an `ExprDef`, or a NULL literal when the clause omits it. */
function valueDefAt(values: readonly Expr[], i: number): ExprDef {
  const v = values[i];
  return v ? v.toJSON() : { kind: 'literal', value: null };
}

/** Read a value expr's string content (empty when it isn't a string literal). */
function literalString(e: Expr | undefined): string {
  if (!e) return '';
  const def = e.toJSON();
  return def.kind === 'literal' && typeof def.value === 'string' ? def.value : '';
}

/** A LIKE pattern literal def wrapping a value with `%` wildcards per `mode`. */
function likePatternDef(value: Expr | undefined, mode: 'contains' | 'startsWith' | 'endsWith'): ExprDef {
  const v = literalString(value);
  const body = mode === 'contains' ? `%${v}%` : mode === 'startsWith' ? `${v}%` : `%${v}`;
  return { kind: 'literal', value: body };
}

/** Parse an `ExprDef` and assert it is a boolean predicate. */
function asBool(expr: Expr): BoolExpr {
  /* v8 ignore next 3 -- unreachable: every op compiles to a boolean expr (comparison / in / between / is-null / array-op / text-search); the guard never fires */
  if (!(expr instanceof BoolExpr)) {
    throw new Error(`FilterOp.compile produced a non-boolean expr '${expr.kind}'.`);
  }
  return expr;
}

// ─── op factories ─────────────────────────────────────────────────────────────

/** A scalar-comparison op (`eq`/`neq`/`lt`/… → `comparison`). */
function comparisonOp(op: string, sqlOp: ComparisonOp): FilterOp {
  return {
    op,
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(registry.parseExpr({ kind: 'comparison', op: sqlOp, left: field.toJSON(), right: valueDefAt(values, 0) })),
    valueSchema: (ft) => ft.toValueSchema(),
  };
}

/**
 * A substring op (`contains`/`startsWith`/`endsWith` → `LIKE`). Case-folding
 * follows the field's `sensitive` flag via the compiled comparison (default
 * case-insensitive).
 */
function patternOp(op: string, mode: 'contains' | 'startsWith' | 'endsWith'): FilterOp {
  return {
    op,
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(registry.parseExpr({ kind: 'comparison', op: 'like', left: field.toJSON(), right: likePatternDef(values[0], mode) })),
    valueSchema: () => z.string(),
  };
}

/** A raw-pattern op (`like`/`ilike` — the value already carries `%`/`_`). */
function likeOp(op: string, sqlOp: ComparisonOp): FilterOp {
  return {
    op,
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(registry.parseExpr({ kind: 'comparison', op: sqlOp, left: field.toJSON(), right: valueDefAt(values, 0) })),
    valueSchema: () => z.string(),
  };
}

/** A membership op (`in`/`notIn` → `in`). */
function membershipOp(op: string, not: boolean): FilterOp {
  return {
    op,
    arity: 'list',
    compile: (field, values, registry) =>
      asBool(registry.parseExpr({ kind: 'in', value: field.toJSON(), in: values.map((v) => v.toJSON()), not })),
    valueSchema: (ft) => z.array(ft.toValueSchema()),
  };
}

/**
 * The element value-schema for an array field's contains-family operands: the
 * declared element type's value schema when known, else the permissive
 * JSON-value schema (NO `z.any()`).
 */
function arrayElementSchema(ft: FieldType): z.ZodTypeAny {
  if (ft instanceof ArrayFieldType && ft.item) return ft.item.toValueSchema();
  return jsonValueSchema();
}

/** A single-element containment op (`contains` → `array-op`). */
function arrayContainsOp(): FilterOp {
  return {
    op: 'contains',
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(
        registry.parseExpr({ kind: 'array-op', op: 'contains', target: field.toJSON(), value: valueDefAt(values, 0) }),
      ),
    valueSchema: (ft) => arrayElementSchema(ft),
  };
}

/** A list containment op (`containsAny`/`containsAll` → `array-op`). */
function arrayListOp(op: 'containsAny' | 'containsAll'): FilterOp {
  return {
    op,
    arity: 'list',
    compile: (field, values, registry) =>
      asBool(
        registry.parseExpr({ kind: 'array-op', op, target: field.toJSON(), value: values.map((v) => v.toJSON()) }),
      ),
    valueSchema: (ft) => z.array(arrayElementSchema(ft)),
  };
}

/** An emptiness op (`isEmpty`/`notEmpty` → `array-op`, no operand). */
function arrayEmptyOp(op: 'isEmpty' | 'notEmpty'): FilterOp {
  return {
    op,
    arity: 'unary',
    compile: (field, _values, registry) =>
      asBool(registry.parseExpr({ kind: 'array-op', op, target: field.toJSON() })),
    valueSchema: () => z.undefined(),
  };
}

/**
 * An array-length op (`lengthEq`/`lengthGt`/… → a `comparison` over the
 * builtin `arrayLength(field)` scalar function). The operand is the element
 * count to compare against.
 */
function arrayLengthOp(op: string, sqlOp: ComparisonOp): FilterOp {
  return {
    op,
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(
        registry.parseExpr({
          kind: 'comparison',
          op: sqlOp,
          left: { kind: 'function-call', function: 'arrayLength', args: { arr: field.toJSON() } },
          right: valueDefAt(values, 0),
        }),
      ),
    valueSchema: () => z.number().int(),
  };
}

/** A null-test op (`isNull`/`notNull`, also relation `exists`/`notExists`). */
function nullOp(op: string, not: boolean): FilterOp {
  return {
    op,
    arity: 'unary',
    compile: (field, _values, registry) =>
      asBool(registry.parseExpr({ kind: 'is-null', value: field.toJSON(), not })),
    // Unary ops take no operand value.
    valueSchema: () => z.undefined(),
  };
}

// ─── the singleton op catalog ──────────────────────────────────────────────────

/** Every built-in filter op, keyed by name (shared across field types). */
const FILTER_OPS: Readonly<Record<string, FilterOp>> = {
  // comparison
  eq: comparisonOp('eq', '='),
  neq: comparisonOp('neq', '<>'),
  lt: comparisonOp('lt', '<'),
  lte: comparisonOp('lte', '<='),
  gt: comparisonOp('gt', '>'),
  gte: comparisonOp('gte', '>='),
  // membership / range
  in: membershipOp('in', false),
  notIn: membershipOp('notIn', true),
  between: {
    op: 'between',
    arity: 'range',
    compile: (field, values, registry) =>
      asBool(
        registry.parseExpr({
          kind: 'between',
          value: field.toJSON(),
          lower: valueDefAt(values, 0),
          upper: valueDefAt(values, 1),
          not: false,
        }),
      ),
    valueSchema: (ft) => z.tuple([ft.toValueSchema(), ft.toValueSchema()]),
  },
  // null tests
  isNull: nullOp('isNull', false),
  notNull: nullOp('notNull', true),
  // text predicates
  contains: patternOp('contains', 'contains'),
  startsWith: patternOp('startsWith', 'startsWith'),
  endsWith: patternOp('endsWith', 'endsWith'),
  like: likeOp('like', 'like'),
  ilike: likeOp('ilike', 'ilike'),
  // full-text search → text-search (over the field's bound source + field)
  search: {
    op: 'search',
    arity: 'binary',
    compile: (field, values, registry) => {
      const fdef = field.toJSON();
      if (fdef.kind !== 'field-ref') throw new Error("'search' filter op requires a field reference.");
      return asBool(
        registry.parseExpr({ kind: 'text-search', source: fdef.source, field: fdef.field, query: literalString(values[0]) }),
      );
    },
    valueSchema: () => z.string(),
  },
  // semantic similarity → semantic score above a threshold (a boolean)
  similar: {
    op: 'similar',
    arity: 'binary',
    compile: (field, values, registry) => {
      const query = literalString(values[0]);
      const fdef = field.toJSON();
      if (fdef.kind !== 'field-ref') throw new Error("'similar' filter op requires a field reference.");
      const semantic: ExprDef = { kind: 'semantic', source: fdef.source, field: fdef.field, query };
      return asBool(
        registry.parseExpr({ kind: 'comparison', op: '>', left: semantic, right: { kind: 'literal', value: SIMILARITY_THRESHOLD } }),
      );
    },
    valueSchema: () => z.string(),
  },
  // relation predicates (the relation field carries the foreign key)
  exists: nullOp('exists', true),
  notExists: nullOp('notExists', false),
  anyMatch: {
    op: 'anyMatch',
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(registry.parseExpr({ kind: 'comparison', op: '=', left: field.toJSON(), right: valueDefAt(values, 0) })),
    valueSchema: (ft) => ft.toValueSchema(),
  },
  // json predicates (best-effort over the serialized document)
  hasKey: {
    op: 'hasKey',
    arity: 'binary',
    compile: (field, values, registry) =>
      asBool(
        registry.parseExpr({
          kind: 'comparison',
          op: 'like',
          left: field.toJSON(),
          right: { kind: 'literal', value: `%"${literalString(values[0])}"%` },
        }),
      ),
    valueSchema: () => z.string(),
  },
  pathEq: {
    op: 'pathEq',
    arity: 'range',
    compile: (field, values, registry) =>
      asBool(
        registry.parseExpr({
          kind: 'comparison',
          op: 'like',
          left: field.toJSON(),
          right: { kind: 'literal', value: `%${literalString(values[1])}%` },
        }),
      ),
    valueSchema: () => z.tuple([z.string(), jsonValueSchema()]),
  },
  // array predicates. NOTE: the single-element membership op is named
  // `contains`, which COLLIDES with text's `contains` (substring LIKE). They
  // mean different things, so the array `contains` op is NOT registered here
  // (text keeps the global name); instead `catalogForFieldType`'s array branch
  // supplies `ARRAY_CONTAINS_OP` directly, and clause compilation prefers the
  // field's catalog op over this global map. The REMAINING array ops have
  // unique names, so they live here too (reachable via global lookup as well).
  containsAny: arrayListOp('containsAny'),
  containsAll: arrayListOp('containsAll'),
  isEmpty: arrayEmptyOp('isEmpty'),
  notEmpty: arrayEmptyOp('notEmpty'),
  lengthEq: arrayLengthOp('lengthEq', '='),
  lengthGt: arrayLengthOp('lengthGt', '>'),
  lengthGte: arrayLengthOp('lengthGte', '>='),
  lengthLt: arrayLengthOp('lengthLt', '<'),
  lengthLte: arrayLengthOp('lengthLte', '<='),
};

/** The array single-element membership op (`contains` → `array-op`). */
const ARRAY_CONTAINS_OP: FilterOp = arrayContainsOp();

/** Look up a filter op by name across the global op map. */
export function filterOpByName(name: string): FilterOp | undefined {
  return FILTER_OPS[name];
}

/** Map a list of op names to their `FilterOp` singletons (skipping unknowns). */
function pick(names: readonly string[]): FilterOp[] {
  const out: FilterOp[] = [];
  for (const n of names) {
    const op = FILTER_OPS[n];
    if (op) out.push(op);
  }
  return out;
}

/** Op set shared by ordered scalar kinds (number / money / date / timestamp). */
const COMPARABLE_OPS: readonly string[] = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'between', 'isNull', 'notNull',
];
/** Base text op set (before the search / semantic extensions). */
const TEXT_OPS: readonly string[] = [
  'eq', 'neq', 'contains', 'startsWith', 'endsWith', 'like', 'ilike', 'in', 'notIn', 'isNull', 'notNull',
];

/**
 * The `FilterOp[]` applicable to a field of type `ft`, EXACTLY as the plan's
 * per-kind catalog lists:
 *  - number / money / date / timestamp ⇒ eq,neq,lt,lte,gt,gte,in,notIn,between,isNull,notNull
 *  - text ⇒ eq,neq,contains,startsWith,endsWith,like,ilike,in,notIn,isNull,notNull
 *          (+ `search` when `options.search`, + `similar` when `options.semantic`)
 *  - bool ⇒ eq,neq,isNull,notNull
 *  - relation ⇒ exists,notExists,anyMatch
 *  - json ⇒ eq,isNull,notNull,hasKey,pathEq
 *  - array ⇒ contains,containsAny,containsAll,isEmpty,notEmpty,
 *            lengthEq,lengthGt,lengthGte,lengthLt,lengthLte,isNull,notNull
 */
export function catalogForFieldType(ft: FieldType): FilterOp[] {
  const kind: ScalarKind = ft.resolve();
  switch (kind) {
    case 'number':
    case 'money':
    case 'date':
    case 'timestamp':
      return pick(COMPARABLE_OPS);
    case 'text': {
      const names = [...TEXT_OPS];
      if (ft instanceof TextFieldType) {
        if (ft.options.search) names.push('search');
        if (ft.options.semantic) names.push('similar');
      }
      return pick(names);
    }
    case 'bool':
      return pick(['eq', 'neq', 'isNull', 'notNull']);
    case 'relation':
      return pick(['exists', 'notExists', 'anyMatch']);
    case 'json':
      return pick(['eq', 'isNull', 'notNull', 'hasKey', 'pathEq']);
    case 'array':
      // `contains` is the dedicated array membership op (see ARRAY_CONTAINS_OP);
      // the rest are unique names served from the global map.
      return [
        ARRAY_CONTAINS_OP,
        ...pick([
          'containsAny', 'containsAll', 'isEmpty', 'notEmpty',
          'lengthEq', 'lengthGt', 'lengthGte', 'lengthLt', 'lengthLte',
          'isNull', 'notNull',
        ]),
      ];
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers ScalarKind (compile-time guard) */
    default:
      return assertNever(kind);
  }
}

/* v8 ignore start -- compile-time exhaustiveness guard; never invoked at runtime */
/** Compile-time exhaustiveness guard over `ScalarKind`. */
function assertNever(value: never): never {
  throw new Error(`catalogForFieldType: unhandled scalar kind ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

// ─── clause → bool Expr (the dev-facing filter-builder helper) ───────────────

/** Build a clause's operand `ExprDef`s (literals) per the op's arity. */
function clauseValueDefs(op: FilterOp, value: ScalarValue | ScalarValue[] | undefined): ExprDef[] {
  if (op.arity === 'unary') return [];
  if (Array.isArray(value)) return value.map((v) => ({ kind: 'literal', value: v }));
  if (value === undefined) return [];
  return [{ kind: 'literal', value }];
}

/**
 * Compile a list of `{ field, op, value }` filter clauses (the filter-builder
 * shape) over `source` into a single AND-combined boolean `Expr` — ready to pass
 * to `engine.run` / `engine.toSQL` as an execution-time filter for that source.
 *
 * A UI collects clauses then calls this to produce the bool `Expr` a `filters`
 * placeholder now expects. Each clause's `op` is resolved via the shared op
 * catalog (`filterOpByName`); an unknown op throws. Zero clauses ⇒ a constant
 * `TRUE`. Like the rest of this module it builds the target as `ExprDef`s and
 * reconstructs them via `registry.parseExpr`, so it imports no concrete expr
 * class (preserving the module-load discipline noted at the top of this file).
 */
export function compileFilters(
  source: string,
  clauses: readonly FilterClauseDef[],
  registry: Registry,
): Expr {
  const compiled: BoolExpr[] = [];
  for (const clause of clauses) {
    const op = filterOpByName(clause.op);
    if (!op) throw new Error(`compileFilters: unknown filter op '${clause.op}'.`);
    const fieldExpr = registry.parseExpr({ kind: 'field-ref', source, field: clause.field });
    const values = clauseValueDefs(op, clause.value).map((d) => registry.parseExpr(d));
    compiled.push(op.compile(fieldExpr, values, registry));
  }
  if (compiled.length === 0) return registry.parseExpr({ kind: 'literal', value: true });
  if (compiled.length === 1) return compiled[0]!;
  return registry.parseExpr({ kind: 'logical', op: 'and', operands: compiled.map((c) => c.toJSON()) });
}
