/**
 * Neutral, depth-aware schema-building primitives shared by BOTH the concrete
 * `Expr` classes (`src/exprs/*`) and the central LLM schema assembler
 * (`src/llm/schemas.ts`). It lives OUTSIDE both layers so each rich expr kind
 * can own ONE depth-aware `static toSchema` (rendering the same shape the
 * central builder used to render in its per-kind switch), while the central
 * builder keeps only capability-gating + folding.
 *
 * To avoid import cycles this module imports NOTHING from `src/llm/` or
 * `src/exprs/`: every registry / Type / selected-function / child-`Expr`
 * dependency arrives by PARAMETER (or as a type-only import). It owns:
 *  - the small union primitives `enumOf` / `orFold` + `paramSchema`;
 *  - the unified depth-aware reference schema `refSchema` and its field
 *    eligibility selectors + the per-kind ref wrappers
 *    (`fieldRefSchema` / `relationPathSchema` / `semanticSchema` /
 *    `textSearchSchema` / `filtersSchema`);
 *  - the function-call schema builder `functionExprSchema` (names / typed);
 *  - the function selection (`selectFunctions`) + the capability gate
 *    (`exprKindApplicable`).
 */
import { z } from 'zod';
import { withAid, withSharedId } from './aids';
import type { Registry } from './registry';
import type { Type } from './type';
import type { Field } from './field';
import type { QueryOperator } from './operator';
import type { FieldBacking } from './backing';
import type { RefDepth, FnDepth, WriteDepth, SelectedFunctions } from './node';
import type { FunctionDef, FunctionShape, ExprKind } from './schema';
import { requiredOnInsert } from './write-model';

// ─── Union primitives ─────────────────────────────────────────────────────────

/**
 * Build a union over a list of string literals WITHOUT a tuple cast — folds
 * `z.literal` branches with `.or`. An empty list collapses to `z.never()`.
 */
export function enumOf(values: readonly string[]): z.ZodTypeAny {
  const unique = Array.from(new Set(values));
  const first = unique[0];
  if (first === undefined) return z.never();
  return unique.slice(1).reduce<z.ZodTypeAny>((acc, v) => acc.or(z.literal(v)), z.literal(first));
}

/** Fold a list of branch schemas into a union with `.or` (no tuple cast). */
export function orFold(branches: readonly z.ZodTypeAny[]): z.ZodTypeAny {
  const first = branches[0];
  if (!first) return z.never();
  return branches.slice(1).reduce<z.ZodTypeAny>((acc, s) => acc.or(s), first);
}

/** The shared `param` expr schema (used by query positions + semantic queries). */
export function paramSchema(): z.ZodTypeAny {
  return z
    .object({ kind: z.literal('param'), name: z.string() })
    .describe('A named bind parameter.');
}

// ─── Shared-fragment cache (structural `$def` factoring) ───────────────────────
//
// A plain `z.toJSONSchema` only factors a fragment into a single `$def` + `$ref`s
// when the SAME instance is reused AND carries an `id` (a merely-reused instance
// with no id is inlined at every site). Absent that, the LARGEST repeated
// fragments — each Type's field-name enum (used by field-ref / relation-path /
// order / group-by / having / filters / text-search / semantic) and the `param`
// expr — are rebuilt fresh at every position and inlined dozens of times,
// bloating the tool-call schema (the `paired` example schema inlines ~43 field
// enums + ~14 `param`s). `SchemaCache` builds each such fragment ONCE per
// schema-generation, tags it with a readable `id` (`Fields_<Type>`, `param`, …)
// in the process-LOCAL `sharedIdRegistry` (see `aids.ts` — kept OFF zod's global
// registry so core's `strictify` never re-registers it and throws), and hands the
// SAME instance back everywhere — so the converter emits it once. Semantics are
// UNCHANGED: a shared instance validates identically to the fresh copies it
// replaces (same shape, same directed error).

/**
 * A monotonic per-process counter, one tick per `SchemaCache`. It SALTS the
 * `$def` ids each cache mints so they stay unique within the process-LOCAL
 * `sharedIdRegistry` (see `aids.ts`): that registry — like zod's global one —
 * THROWS on a duplicate id, so two schema generations both minting a bare `param`
 * id would collide. The FIRST cache keeps clean, readable ids (`param`,
 * `Fields_user`, `Limit`); every later one appends a `_g<generation>` suffix. The
 * ids live OFF zod's global registry precisely so core's `strictify` (which
 * clones every node and re-applies its `.meta()`) never re-registers one and
 * throws; and because core's converter names its `$defs` by `aid` not `id`, the
 * model-facing schema is unaffected by the suffix either way.
 */
let cacheGeneration = 0;

/**
 * Per-`buildSchemas` cache of shared, id-tagged fragment instances (ids in the
 * process-LOCAL `sharedIdRegistry`, see `aids.ts`), so a plain `z.toJSONSchema`
 * (told to read that registry) and core's converter factor each repeated fragment
 * into a single `$def` + `$ref`s instead of inlining every copy. Keyed by CONTENT
 * so two positions producing the identical fragment share one instance.
 */
export class SchemaCache {
  /** This cache's generation, salting its ids to stay unique in `sharedIdRegistry`. */
  private readonly generation = ++cacheGeneration;
  /** content-key → the built, id-tagged instance. */
  private readonly byKey = new Map<string, z.ZodTypeAny>();
  /** id base → how many distinct fragments have claimed it (for `_2` suffixes). */
  private readonly baseUses = new Map<string, number>();

  /**
   * A process-unique, mostly-readable `$def` id for `idBase`: disambiguated to
   * `idBase_2`, `idBase_3`, … when a DIFFERENT fragment in THIS cache already
   * claimed the base, then salted with `_g<generation>` for every cache after
   * the first so ids never collide in the process-local `sharedIdRegistry`.
   */
  defId(idBase: string): string {
    const used = this.baseUses.get(idBase) ?? 0;
    this.baseUses.set(idBase, used + 1);
    const local = used === 0 ? idBase : `${idBase}_${used + 1}`;
    return this.generation === 1 ? local : `${local}_g${this.generation}`;
  }

  /**
   * Return the shared instance for `contentKey`, building (and id-tagging) it on
   * first request via {@link defId}. Two positions producing the identical
   * fragment (same `contentKey`) share ONE instance ⇒ one `$def` + `$ref`s.
   */
  private shared(contentKey: string, idBase: string, build: (id: string) => z.ZodTypeAny): z.ZodTypeAny {
    const cached = this.byKey.get(contentKey);
    if (cached) return cached;
    const instance = build(this.defId(idBase));
    this.byKey.set(contentKey, instance);
    return instance;
  }

  /**
   * A shared `FieldName` enum over `names` (a Type's eligible fields), id
   * `Fields_<typeHint>`. Reused across every reference position that enumerates
   * the same field set.
   */
  fieldEnum(names: readonly string[], typeHint: string): z.ZodTypeAny {
    // The separator is a real NUL in the KEY but is spelled as an ESCAPE here:
    // a literal NUL byte in a source file makes ripgrep classify the whole file
    // as binary, so every search over it silently returns nothing.
    const key = `fields\u0000${names.join('\u0000')}`;
    return this.shared(key, `Fields_${typeHint}`, (id) => withAid(enumOf(names), 'FieldName', { id }));
  }

  /** The shared `param` expr fragment (id `param`). */
  param(): z.ZodTypeAny {
    return this.shared('param', 'param', (id) =>
      withSharedId(
        z.object({ kind: z.literal('param'), name: z.string() }).describe('A named bind parameter.'),
        id,
      ),
    );
  }

  /**
   * A shared typed-args `strictObject` for a function, keyed by its argument
   * SIGNATURE (param names + optionality) — NOT its name. The 100+ registered
   * functions collapse to a few dozen distinct signatures (e.g. dozens share a
   * lone `value` argument), so this is the single biggest paired-schema win.
   * The `child` (any-`Expr`) is the SAME shared instance for every function, so
   * the signature fully determines the shape; the describe names the signature's
   * params rather than the function, keeping it accurate for every sharer.
   */
  typedArgs(fn: FunctionDef, child: z.ZodTypeAny): z.ZodTypeAny {
    const params = fn.params.map((p) => `${p.name}${p.optional ? '?' : ''}`);
    return this.shared(`args ${params.join(',')}`, 'Args', (id) => {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const param of fn.params) shape[param.name] = param.optional ? child.optional() : child;
      const named = params.length ? params.join(', ') : 'none';
      return withSharedId(z.strictObject(shape).describe(`Named arguments: ${named}.`), id);
    });
  }
}

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

// ─── The unified depth-aware reference schema helper ──────────────────────────
//
// ONE builder renders EVERY `{ key, field(s) }` reference position at a given
// `RefDepth`, so `field-ref` / `relation-path` / `join.on` / `semantic` /
// `text-search` / `filters` (and the semantic query's Type+field ref) all share
// the same depth ladder. It is parameterized by three knobs:
//
//  - `keyName`     — the key property: `'source'` (a BOUND name — a Type name,
//                    join alias, CTE, or aliased source) or `'type'` (a value
//                    that MUST be a registered Type name).
//  - `fieldMode`   — the field property's requiredness / shape:
//                      `'none'`     — no field property (key only);
//                      `'one'`      — a required single `field`;
//                      `'optional'` — an optional single `field?`;
//                      `'list'`     — an optional `fields?: string[]` allowlist;
//                      `'path'`     — a relation `path` tuple (relation-path only).
//  - `eligible`    — which of a Type's fields the position may name (drives the
//                    PER-TYPE `paired` enum and the cross-Type `fields`/`both`
//                    enum).
//
// The five `RefDepth` levels render exactly as the legacy `fieldRefSchema` did:
//  - `open`   — `key` + `field` free strings;
//  - `types`  — `key` is an enum of Type names; `field` open;
//  - `fields` — `key` open; `field` an enum of eligible field names;
//  - `both`   — both enumerated but UNPAIRED;
//  - `paired` — a per-Type discriminated union pinning the key literal to one
//               Type's name and the field enum to ONLY that Type's eligible
//               fields (so a cross-Type pairing can't validate).

/** The field-property requiredness / shape a reference position renders. */
type RefFieldMode = 'none' | 'one' | 'optional' | 'list';

/** Knobs for `refSchema` — everything except the Types + depth. */
export interface RefSchemaOptions {
  /** The key property: a bound `source`, or a must-be-defined `type`. */
  keyName: 'source' | 'type';
  /** The field property's shape (see `RefFieldMode`). */
  fieldMode: RefFieldMode;
  /** A Type's fields eligible for this position (the paired-enum source). */
  eligible: FieldEligibility;
  /** Extra object properties merged into EVERY branch (e.g. `kind`, `query`). */
  extras?: Record<string, z.ZodTypeAny>;
  /** `aid` for the single-object levels; paired branches append `_<Type>`. */
  aid?: string;
  /** Top-level `.describe(...)` for the whole reference. */
  describe: string;
}

/** The distinct eligible field NAMES across a set of Types (stable order). */
function eligibleFieldNames(types: readonly Type[], eligible: FieldEligibility): string[] {
  const seen = new Set<string>();
  for (const t of types) for (const f of eligible(t)) seen.add(f.name);
  return Array.from(seen);
}

/** A field-property Zod schema for one mode, given the `field` value schema. */
function fieldProperty(mode: RefFieldMode, fieldValue: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  switch (mode) {
    case 'none':
      return {};
    case 'one':
      return { field: fieldValue.describe('A field of the referenced source.') };
    case 'optional':
      return { field: fieldValue.optional().describe('A field to narrow to (omit for the whole source).') };
    case 'list':
      return { fields: z.array(fieldValue).optional().describe('Optional allowlist of fields the reference may touch.') };
    /* v8 ignore next 2 -- unreachable: `mode` exhaustively covers RefFieldMode (compile-time guard) */
    default:
      return assertNeverFieldMode(mode);
  }
}

/** Assemble one reference object (a single branch) from its parts. */
function refObject(
  keyName: 'source' | 'type',
  keyValue: z.ZodTypeAny,
  fieldProps: Record<string, z.ZodTypeAny>,
  extras: Record<string, z.ZodTypeAny> | undefined,
  aid: string | undefined,
  describe: string,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = { [keyName]: keyValue, ...fieldProps, ...extras };
  const obj = z.object(shape);
  return (aid ? withAid(obj, aid) : obj).describe(describe);
}

/**
 * The unified depth-aware reference schema. See the block comment above for the
 * `keyName` / `fieldMode` / `eligible` semantics and the `RefDepth` ladder.
 */
export function refSchema(
  types: readonly Type[],
  depth: RefDepth,
  opts: RefSchemaOptions,
  cache?: SchemaCache,
): z.ZodTypeAny {
  const keyNoun = opts.keyName === 'type' ? 'a registered Type name' : 'a bound source name';
  /** A shared (id-tagged) FieldName enum when a cache is present, else a fresh one. */
  const fieldEnum = (names: readonly string[], typeHint: string): z.ZodTypeAny =>
    cache ? cache.fieldEnum(names, typeHint) : withAid(enumOf(names), 'FieldName');

  if (depth === 'paired') {
    // One branch per Type: the key pinned to the Type's name, the field enum to
    // ONLY that Type's eligible fields.
    const branches = types.map((t) => {
      const names = opts.eligible(t).map((f) => f.name);
      const fieldValue = names.length ? fieldEnum(names, t.name) : z.string();
      const keyValue = z.literal(t.name).describe(`The \`${t.name}\` ${opts.keyName} (its Type name).`);
      const fieldProps = fieldProperty(opts.fieldMode, fieldValue);
      return refObject(
        opts.keyName,
        keyValue,
        fieldProps,
        opts.extras,
        opts.aid ? `${opts.aid}_${t.name}` : undefined,
        `A reference into \`${t.name}\`.`,
      );
    });
    return orFold(branches).describe(opts.describe);
  }

  // The flat (non-paired) levels: enumerate the key and/or field independently.
  const enumKey = depth === 'types' || depth === 'both';
  const enumField = depth === 'fields' || depth === 'both';
  const keyBase = enumKey ? enumOf(types.map((t) => t.name)) : z.string();
  // An enumerated `type` key MUST name a registered Type; tag it so a bad value
  // reads "expected a registered Type name" (an enumerated bound `source` key
  // may still be an alias, so it keeps the plain message).
  const keyTagged = enumKey && opts.keyName === 'type' ? withAid(keyBase, 'TypeName') : keyBase;
  const keyValue = keyTagged.describe(
    enumKey ? `${keyNoun[0]!.toUpperCase()}${keyNoun.slice(1)}.` : `A ${opts.keyName} name.`,
  );
  const fieldNames = eligibleFieldNames(types, opts.eligible);
  const fieldValue =
    enumField && fieldNames.length ? fieldEnum(fieldNames, 'any') : z.string();
  const fieldProps = fieldProperty(opts.fieldMode, fieldValue);
  return refObject(opts.keyName, keyValue, fieldProps, opts.extras, opts.aid, opts.describe);
}

// ─── Per-kind ref schemas (called from the rich expr classes) ──────────────────

/** The `field-ref` schema at a `RefDepth` — `source` + a required `field`. */
export function fieldRefSchema(types: readonly Type[], depth: RefDepth, cache?: SchemaCache): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'one',
    eligible: allowingExpr(allFields, 'field-ref'),
    extras: { kind: z.literal('field-ref') },
    aid: 'Expr_field-ref',
    describe: 'A direct field reference.',
  }, cache);
}

/** The `param` expr fragment: the shared cached instance, or a fresh one. */
function paramFragment(cache?: SchemaCache): z.ZodTypeAny {
  return cache ? cache.param() : paramSchema();
}

/** The semantic `query` schema: text, a param, a bound source+field, or a semantic Type+field. */
function semanticQuerySchema(types: readonly Type[], depth: RefDepth, cache?: SchemaCache): z.ZodTypeAny {
  const sourceField = refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'one',
    eligible: semanticFieldsOf,
    describe: 'Another BOUND source + semantic field whose embedding is the query vector (cross-source pairing).',
  }, cache);
  const typeField = refSchema(types, depth, {
    keyName: 'type',
    fieldMode: 'one',
    eligible: semanticFieldsOf,
    describe: 'A semantic Type + field, resolved to that Type\'s single bound source, whose embedding is the query vector.',
  }, cache);
  return orFold([
    z.string().describe('A literal natural-language query.'),
    paramFragment(cache),
    sourceField,
    typeField,
  ]).describe('The query: text, a param, a bound source+field, or a semantic Type+field.');
}

/** The `semantic` schema at a `RefDepth` — `source` + optional `field` + query. */
export function semanticSchema(types: readonly Type[], depth: RefDepth, cache?: SchemaCache): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'optional',
    eligible: allowingExpr(semanticFieldsOf, 'semantic'),
    extras: { kind: z.literal('semantic'), query: semanticQuerySchema(types, depth, cache) },
    aid: 'Expr_semantic',
    describe: 'Semantic-similarity score (requires an embedder).',
  }, cache);
}

/** The `text-search` schema at a `RefDepth` — `source` + optional `field` + query. */
export function textSearchSchema(types: readonly Type[], depth: RefDepth, cache?: SchemaCache): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'optional',
    eligible: allowingExpr(textFieldsOf, 'text-search'),
    extras: {
      kind: z.literal('text-search'),
      query: z.string().or(paramFragment(cache)).describe('Search query: a literal string or a param.'),
    },
    aid: 'Expr_text-search',
    describe: 'Full-text search predicate.',
  }, cache);
}

/** The `text-score` schema at a `RefDepth` — `source` + optional `field` + query. */
export function textScoreSchema(types: readonly Type[], depth: RefDepth, cache?: SchemaCache): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'optional',
    eligible: allowingExpr(textFieldsOf, 'text-score'),
    extras: {
      kind: z.literal('text-score'),
      query: z.string().or(paramFragment(cache)).describe('Search query: a literal string or a param.'),
    },
    aid: 'Expr_text-score',
    describe: 'Numeric full-text relevance score (usable in SELECT / ORDER BY).',
  }, cache);
}

/**
 * The `filters` placeholder schema. The `filters` axis is two-level (`open` /
 * `paired`), mapped onto the ref ladder: `open` leaves `source` + `fields` free,
 * `paired` pins `source` to a Type and the `fields` allowlist to that Type's
 * fields (every field is filterable). NO clause shapes appear — clauses are
 * execution-time only.
 */
export function filtersSchema(types: readonly Type[], depth: 'open' | 'paired', cache?: SchemaCache): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'list',
    eligible: allowingExpr(allFields, 'filters'),
    extras: { kind: z.literal('filters') },
    aid: 'Expr_filters',
    describe: 'A structured filter placeholder; clauses are supplied at execution time.',
  }, cache);
}

/**
 * The `sorter` placeholder schema — a dynamic-sort catalog, offered ONLY inside a
 * SELECT `order` position (never in the general Expr union). `sorts` is a record
 * of named CHILD exprs (`childExpr`, so it observes the caller's Expr depth) and
 * `defaultSort` is an optional list of `{ sort, dir }` keys; the actual SELECTION
 * is an execution-time input, never authored here. Mirrors how `filtersSchema` is
 * consumed by `FiltersExpr.toSchema` and the central builder.
 */
export function sorterSchema(childExpr: z.ZodTypeAny): z.ZodTypeAny {
  const entry = z.object({
    sort: z.string().describe('A declared sort name (a key of `sorts`).'),
    dir: withAid(enumOf(['asc', 'desc']), 'OrderDir'),
  });
  return withAid(
    z.object({
      kind: z.literal('sorter'),
      sorts: z
        .record(z.string(), childExpr)
        .describe('Named sortable expressions (sort name → expr); the caller selects by name at run time.'),
      defaultSort: z
        .array(entry)
        .optional()
        .describe('Default multi-key sort (each `{ sort, dir }`) applied when the caller selects none.'),
    }),
    'Expr_sorter',
  ).describe('A dynamic-sort catalog (valid only in a SELECT `order`); the selection is supplied at execution time.');
}

// ─── Write-model value schemas (INSERT rows / UPDATE SET) ──────────────────────
//
// The `writes` axis (`open` / `names` / `typed`) shapes an INSERT row / UPDATE
// SET record. `open` is assembled directly in `llm/schemas.ts` (a loose
// `z.record(string, Expr)`); the `names` / `typed` per-Type object shapes are
// built HERE so the central assembler only folds the per-Type branches. A
// field's VALUE at `typed` is either the field's own typed value schema
// (`toValueSchema()`) OR a full Expr; at `names` it is just an Expr.

/** How a field's backing is looked up (by Type name + field name). */
export type BackingLookup = (typeName: string, field: string) => FieldBacking | undefined;

/**
 * One writable field's VALUE schema at a `WriteDepth`:
 *  - `typed` — the field's own `toValueSchema()` OR a full `Expr`;
 *  - `names` — just a full `Expr`.
 * (`open` never calls this — it uses a loose record whose values are Exprs.)
 */
export function writeValueSchema(field: Field, writes: 'names' | 'typed', Expr: z.ZodTypeAny): z.ZodTypeAny {
  if (writes === 'typed') {
    return field.fieldType
      .toValueSchema()
      .or(Expr)
      .describe(`A ${field.fieldType.kind} value, or an expression.`);
  }
  return Expr;
}

/**
 * The per-Type INSERT-ROW object at `names` / `typed`: a `strictObject` whose
 * keys are the Type's INSERTABLE fields (so an unknown / non-insertable field is
 * rejected). At `typed` each REQUIRED-on-insert field is a non-optional key
 * (enforcing the required set structurally) and its value is the typed union;
 * at `names` every key is optional and its value is a plain Expr. A Type with no
 * insertable fields yields `strictObject({})` (only `{}` validates).
 */
export function insertRowSchema(
  type: Type,
  fbOf: BackingLookup,
  writes: 'names' | 'typed',
  Expr: z.ZodTypeAny,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of type.fields) {
    const fb = fbOf(type.name, f.name);
    if (!f.insertableFor(fb)) continue;
    const value = writeValueSchema(f, writes, Expr);
    const required = writes === 'typed' && requiredOnInsert(f, fb);
    shape[f.name] = required ? value : value.optional();
  }
  return z.strictObject(shape).describe(`A row to insert into ${type.name} (field → value).`);
}

/**
 * The per-Type UPDATE-SET object at `names` / `typed`: a `strictObject` whose
 * keys are the Type's UPDATABLE fields (unknown / non-updatable rejected). Every
 * key is OPTIONAL (an UPDATE never requires a field); the value schema follows
 * `writeValueSchema`. `Expr` may be widened by the caller (e.g. ON CONFLICT DO
 * UPDATE folds in the `excluded` expr).
 */
export function updateSetSchema(
  type: Type,
  fbOf: BackingLookup,
  writes: 'names' | 'typed',
  Expr: z.ZodTypeAny,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of type.fields) {
    const fb = fbOf(type.name, f.name);
    if (!f.updatableFor(fb)) continue;
    shape[f.name] = writeValueSchema(f, writes, Expr).optional();
  }
  return z.strictObject(shape).describe(`Fields to set on ${type.name} (field → value).`);
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

/** The selected functions for one shape. */
function functionsForShape(s: SelectedFunctions, shape: FunctionShape): FunctionDef[] {
  switch (shape) {
    case 'scalar':
      return s.scalar;
    case 'tabular':
      return s.tabular;
    case 'window':
      return s.window;
    case 'aggregate':
      return s.aggregate;
    /* v8 ignore next 2 -- unreachable: `shape` exhaustively covers FunctionShape (compile-time guard) */
    default:
      return assertNeverShape(shape);
  }
}

// ─── Function-call schema (names / typed) ──────────────────────────────────────

/** The four function-call expr kinds (their `KIND` literals). */
export type FnExprKind = 'function-call' | 'tabular-function-call' | 'aggregate' | 'window';

/** The function SHAPE an expr kind dispatches to (function-call ⇒ scalar, …). */
function shapeForKind(kind: FnExprKind): FunctionShape {
  switch (kind) {
    case 'function-call':
      return 'scalar';
    case 'tabular-function-call':
      return 'tabular';
    case 'aggregate':
      return 'aggregate';
    case 'window':
      return 'window';
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers FnExprKind (compile-time guard) */
    default:
      return assertNeverKind(kind);
  }
}

/** The window `orderBy` entry schema (matches `WindowExpr.toSchema`). */
function windowOrderSchema(child: z.ZodTypeAny): z.ZodTypeAny {
  return z.array(
    z.object({
      expr: child,
      dir: z.enum(['asc', 'desc']),
      nulls: z.enum(['first', 'last']).optional(),
    }),
  );
}

/**
 * Assemble a function-call object for a given kind, with caller-supplied
 * `function` + `args` field schemas plus the kind's shape extras (aggregate ⇒
 * `distinct`; window ⇒ `partitionBy` / `orderBy`).
 */
function functionObject(
  kind: FnExprKind,
  functionField: z.ZodTypeAny,
  argsField: z.ZodTypeAny,
  child: z.ZodTypeAny,
): z.ZodTypeAny {
  switch (kind) {
    case 'function-call':
      return withAid(
        z.object({ kind: z.literal('function-call'), function: functionField, args: argsField }),
        'Expr_function-call',
      ).describe('A scalar function call with named arguments.');
    case 'tabular-function-call':
      return withAid(
        z.object({ kind: z.literal('tabular-function-call'), function: functionField, args: argsField }),
        'Expr_tabular-function-call',
      ).describe('A type-valued function call (produces rows).');
    case 'aggregate':
      return withAid(
        z.object({
          kind: z.literal('aggregate'),
          function: functionField,
          args: argsField,
          distinct: z.boolean().optional(),
        }),
        'Expr_aggregate',
      ).describe('Aggregate function over named args (count with empty args = count(*)).');
    case 'window':
      return withAid(
        z.object({
          kind: z.literal('window'),
          function: functionField,
          args: argsField,
          partitionBy: z.array(child).optional(),
          orderBy: windowOrderSchema(child).optional(),
        }),
        'Expr_window',
      ).describe('Window function over a partition / ordering, with named args.');
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers FnExprKind (compile-time guard) */
    default:
      return assertNeverKind(kind);
  }
}

/**
 * The strict per-function `args` object built from its declared parameters. When
 * a `cache` is present it returns the SHARED, signature-keyed instance (so the
 * many functions with the identical argument signature collapse to one `$def`);
 * otherwise it builds a fresh copy (the bare-`Cls.toSchema()` path). Either way
 * `strictObject` REJECTS an undeclared argument name (the whole point of
 * `typed`), while declared-but-optional params may be omitted.
 */
function typedArgsSchema(fn: FunctionDef, child: z.ZodTypeAny, cache?: SchemaCache): z.ZodTypeAny {
  if (cache) return cache.typedArgs(fn, child);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of fn.params) {
    shape[param.name] = param.optional ? child.optional() : child;
  }
  return z.strictObject(shape).describe(`Named arguments for \`${fn.name}\`.`);
}

/**
 * The function-call schema for one expr kind at a given `FnDepth`:
 *  - `open`  — the kind's own open shape (passed in by the class) — free name +
 *              loose args; old behavior.
 *  - `names` — `function` enum-locked to the selected names for the kind's
 *              shape; `args` a loose record.
 *  - `typed` — a discriminated union, one branch per selected function of the
 *              matching shape, each with a strict named-arg object.
 *
 * `selected` is undefined only for a bare `Cls.toSchema()` (no central build);
 * combined with the `open` default that path renders the open shape.
 */
export function functionExprSchema(
  kind: FnExprKind,
  openSchema: z.ZodTypeAny,
  selected: SelectedFunctions | undefined,
  depth: FnDepth,
  child: z.ZodTypeAny,
  cache?: SchemaCache,
): z.ZodTypeAny {
  if (depth === 'open' || !selected) return openSchema;
  const fns = functionsForShape(selected, shapeForKind(kind));

  if (depth === 'names') {
    const functionField = withAid(enumOf(fns.map((f) => f.name)), 'FunctionName').describe(
      'A selected function name.',
    );
    const argsField = withAid(z.record(z.string(), child), 'FunctionArgs').describe(
      'Arguments keyed by declared parameter name.',
    );
    return functionObject(kind, functionField, argsField, child);
  }

  // `typed` — one branch per selected function of the matching shape.
  const branches = fns.map((fn) => {
    const hasRequired = fn.params.some((p) => !(p.optional ?? false));
    const argsObj = typedArgsSchema(fn, child, cache);
    return functionObject(
      kind,
      z.literal(fn.name).describe(`The \`${fn.name}\` function.`),
      hasRequired ? argsObj : argsObj.optional(),
      child,
    );
  });
  return branches.length > 0 ? orFold(branches) : z.never();
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

// ─── Exhaustiveness guards ─────────────────────────────────────────────────────

/* v8 ignore start -- compile-time exhaustiveness guards; never invoked at runtime */
/** Compile-time exhaustiveness guard over `FunctionShape`. */
function assertNeverShape(value: never): never {
  throw new Error(`schema-build: unhandled function shape ${JSON.stringify(value)}`);
}

/** Compile-time exhaustiveness guard over `FnExprKind`. */
function assertNeverKind(value: never): never {
  throw new Error(`schema-build: unhandled function-call kind ${JSON.stringify(value)}`);
}

/** Compile-time exhaustiveness guard over `RefFieldMode`. */
function assertNeverFieldMode(value: never): never {
  throw new Error(`schema-build: unhandled ref field mode ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
