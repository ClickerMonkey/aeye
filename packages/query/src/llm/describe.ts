/**
 * Compact, LLM-facing descriptions of the query meta-model.
 *
 * `describeType(type)` renders one Type as a short block an LLM can read to
 * understand what it may query: the Type's name / label / description, then
 * each field (name, type, nullability, label, description), then its
 * relations and indexes. `describeExprs(engine)` lists the CAPABILITY-GATED
 * expression kinds usable for the current Types / functions (each with its
 * `static INSTRUCTIONS` and, capped by `maxExamples`, its `static EXAMPLES`).
 * `describeEngine(engine)` composes everything a caller can use — every
 * registered Type, the usable expr kinds, the available functions (each with its
 * worked `examples`), a worked query-examples section, and the SQL dialects —
 * into one block. Worked examples live on the NODE / FUNCTION classes (their
 * `EXAMPLES` / `examples`) as the ONE source of truth; `describeEngine` just
 * renders them (up to `maxExamples` per node / function).
 *
 * Type / Field `label` (short) + `description` (long) are DEV-OVERRIDABLE and
 * fall back to sensible generated defaults (see `describe-generate.ts`), so
 * every rendered node carries a doc even when none was authored.
 *
 * Output is plain text (markdown-ish), deliberately terse to keep token cost
 * low; nothing here is parsed, so the format is free to evolve.
 */
import type { QueryEngine } from '../engine';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Field } from '../field';
import type { ExprDef, FunctionDef, FunctionShape } from '../schema';
import type { FieldType } from '../field-type';
import { ArrayFieldType, RelationFieldType, TextFieldType, MoneyFieldType } from '../field-types/index';
import { hasFieldDefault, type DefaultCondition, type DefaultOrder, type FieldBacking, type TypeBacking } from '../backing';
import { describeValues } from '../field-types/_values';
import { defaultConditionWithout } from '../default-conditions';
import { exprKindApplicable } from '../schema-build';
import { fieldMeta, typeMeta } from './describe-generate';
import { selectFunctions, type FunctionSelector } from './schemas';

/**
 * Default cap on WORKED examples rendered PER function / node in the composed
 * docs. Examples teach shape; a small cap keeps the prompt terse. Callers raise
 * it via `describeEngine({ maxExamples })` (or the per-function/expr helpers).
 */
export const DEFAULT_MAX_EXAMPLES = 2;

/**
 * A caller's per-item OVERRIDES for the rendered docs, keyed by function NAME or
 * node KIND (functions are keyed by name, expr / query nodes by kind — one flat
 * namespace, the strings are distinct). A present key REPLACES that item's
 * shipped `INSTRUCTIONS` / `EXAMPLES` (the shipped values remain the fallback for
 * any key NOT present); an absent / empty map renders exactly the shipped docs.
 * Override strings are the CALLER's responsibility — they are rendered verbatim,
 * not structurally validated (a caller can pre-check example strings via a bare
 * `createRegistry().parseCheckedQuery` / `parseCheckedExpr`, mirroring the shipped
 * test, before passing them here). Example lists are still capped by `maxExamples`.
 */
export interface DescribeOverrides {
  /** name/kind → the INSTRUCTIONS line to render in place of the shipped one. */
  instructions?: Record<string, string>;
  /** name/kind → the EXAMPLES to render in place of the shipped ones (raw JSON strings). */
  examples?: Record<string, readonly string[]>;
}

/** The shipped INSTRUCTIONS for `key`, replaced by the caller's override when present. */
function overrideInstructions(
  key: string,
  shipped: string | undefined,
  overrides: DescribeOverrides,
): string | undefined {
  return overrides.instructions?.[key] ?? shipped;
}

/** The shipped EXAMPLES for `key`, replaced by the caller's override when present. */
function overrideExamples(
  key: string,
  shipped: readonly string[] | undefined,
  overrides: DescribeOverrides,
): readonly string[] | undefined {
  return overrides.examples?.[key] ?? shipped;
}

/**
 * Render up to `max` raw-JSON `examples` as terse `e.g. <json>` lines under a
 * catalog entry, each prefixed by `indent`. Examples are emitted VERBATIM (they
 * are already raw JSON strings); an empty / absent list or `max <= 0` yields no
 * lines. The ONE renderer shared by the expr, function, and query sections.
 */
function exampleLines(
  examples: readonly string[] | undefined,
  max: number,
  indent: string,
): string[] {
  if (!examples || max <= 0) return [];
  return examples.slice(0, max).map((raw) => `${indent}e.g. ${raw}`);
}

/** A readable label for an index's stored `ExprDef` (raw JSON this phase). */
function indexExprText(expr: ExprDef): string {
  if (expr.kind === 'field-ref') return `${expr.source}.${expr.field}`;
  return expr.kind;
}

/** Narrow a `QueryEngine | Registry` to its `Registry` without a cast. */
function toRegistry(engineOrRegistry: QueryEngine | Registry): Registry {
  return 'registry' in engineOrRegistry ? engineOrRegistry.registry : engineOrRegistry;
}

/**
 * A short type tag for one field, e.g. `money(USD) one of 0|10`,
 * `relation→order×12`, or `array<text one of a|b>`.
 *
 * The closed value set is appended UNIFORMLY from the total
 * `FieldType.values()`, not inside the per-class branches, and a CONTAINER
 * renders its element type recursively. Asking each class separately, one level
 * deep, is exactly what left `money` — whose set lives in its inner
 * `NumberOptions` bag — rendering as a bare `money(USD)`, and an array of an
 * enum rendering as a bare `array`. Both are the same failure: the write check
 * refuses (`write.value`) against a set the model was never shown, leaving
 * guess-and-retry as its only recovery. Enforcing membership and RENDERING it
 * are one feature. The branches below decide the BASE tag only.
 */
function fieldTypeTag(field: Field): string {
  return typeTag(field.fieldType);
}

/** A field type's full tag: its base plus its own closed set. */
function typeTag(ft: FieldType): string {
  return fieldTypeBase(ft) + describeValues(ft.values());
}

/** A `(a,b)` qualifier list, or `''` when there is nothing to qualify. */
function quals(parts: readonly string[]): string {
  return parts.length ? `(${parts.join(',')})` : '';
}

/**
 * `key=value` qualifiers for the options a column's refinement declares for
 * itself, in DECLARATION order (not the column's), so two columns of one type
 * read alike.
 *
 * An option with no value at all — declared with no `default` and unset on this
 * column — is omitted rather than rendered as empty: there is nothing true to
 * say about it.
 */
function refinementOptionQuals(ft: FieldType): string[] {
  const refinement = ft.refinement;
  if (!refinement) return [];
  const parts: string[] = [];
  for (const key of refinement.ownOptions.keys()) {
    const value = ft.refinementOption(key);
    if (value !== undefined) parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return parts;
}

/**
 * The arms of the comparison grammar a column's registered type REFUSES,
 * rendered as `no <arm>` — `json(as Geometry,no <,no LIKE)`.
 *
 * The declaration is the only place that knows, and until this rendered existed
 * the ONLY channel was whatever the declarer happened to type into
 * `instructions`. That is a retry waiting to happen, and by this package's own
 * accounting a retry costs thousands of tokens to save the twenty this line
 * spends: a model with no way to know `<` is unavailable finds out by writing
 * one, failing validation, and re-reading the whole schema.
 *
 * Rendered as the OPERATORS a model would write rather than as the declaration's
 * key names (`no <` rather than `ordering: false`), because the tag is read
 * while choosing an operator, not while writing a declaration. Nothing is
 * rendered for a type that refuses nothing, so an existing tag is unchanged.
 */
function refinementCompareQuals(ft: FieldType): string[] {
  const compare = ft.refinement?.compare;
  if (!compare) return [];
  const parts: string[] = [];
  if (!compare.equality) parts.push('no =');
  if (!compare.ordering) parts.push('no <');
  if (!compare.textMatch) parts.push('no LIKE');
  return parts;
}

/**
 * The kind-specific part of a type tag, without its own closed value set.
 *
 * A registered REFINEMENT is the FIRST qualifier on every kind —
 * `text(as uuid)`, `text(as uuid,search)`, `json(as Geometry)` — because it is
 * the most specific true thing about the column and the one a model should read
 * before the base's own flags. The NAME renders VERBATIM: a model reads this
 * surface and a sibling type system's in one session, and a spelling difference
 * between them reads as two different types.
 *
 * The `as ` prefix is not decoration. A bare first qualifier is AMBIGUOUS on any
 * kind that already has a non-flag one — `money(Usd,USD)` gives a model no way
 * to tell which token is the refinement and which the currency — and the prefix
 * doubles as the answer, because it names the very key the model has to write to
 * ask for one (`{kind:'money', as:'Usd'}`).
 *
 * The refinement's OWN options follow it as `key=value`
 * (`json(as Geometry,subtype=Polygon,srid=4326)`), rendered from their EFFECTIVE
 * values — the column's own, or the type's declared default. A defaulted option
 * is shown rather than elided because it is a fact about the column either way,
 * and a model reading `geometry(Point,4326)` in the emitted SQL of one column
 * and nothing in the description of another has no way to know which SRID it is
 * writing against.
 *
 * Then the arms of the comparison grammar the type REFUSES (`no <`, `no LIKE`)
 * — see {@link refinementCompareQuals} for why a refusal a model can only
 * discover by tripping over it is the expensive kind.
 */
function fieldTypeBase(ft: FieldType): string {
  const parts: string[] = [];
  if (ft.as !== undefined) parts.push(`as ${ft.as}`, ...refinementOptionQuals(ft), ...refinementCompareQuals(ft));
  if (ft instanceof ArrayFieldType) {
    // The element type is where an array's constraints actually live — without
    // it the model cannot author an element at all, let alone a member of a set.
    return `array${quals(parts)}${ft.item ? `<${typeTag(ft.item)}>` : ''}`;
  }
  if (ft instanceof RelationFieldType) {
    // A `relation` is not refinable (`REFINABLE_BASES`), so `parts` is empty
    // here for any type this package built — the qualifier is kept for
    // uniformity rather than to render something.
    return `relation${quals(parts)}→${ft.to}×${ft.count}`;
  }
  if (ft instanceof MoneyFieldType) {
    if (ft.options.currency) parts.push(ft.options.currency);
    return `money${quals(parts)}`;
  }
  if (ft instanceof TextFieldType) {
    if (ft.options.search) parts.push('search');
    if (ft.options.semantic) parts.push('semantic');
    return `text${quals(parts)}`;
  }
  return `${ft.kind}${quals(parts)}`;
}

/** A terse `write:` clause for a Type's restricted write permissions, or `''`. */
function typeWriteNote(type: Type): string {
  if (!type.insertable && !type.updatable && !type.deletable) return 'write: read-only';
  const w: string[] = [];
  if (!type.insertable) w.push('no-insert');
  if (!type.updatable) w.push('no-update');
  if (!type.deletable) w.push('no-delete');
  return w.length ? `write: ${w.join(', ')}` : '';
}

/** A terse `[…]` clause of a field's write-model deviations from the permissive default, or `''`. */
function fieldWriteNote(field: Field, fb: FieldBacking | undefined): string {
  const notes: string[] = [];
  if (!field.insertableFor(fb)) notes.push('non-insertable');
  if (!field.updatableFor(fb)) notes.push('non-updatable');
  if (hasFieldDefault(fb)) notes.push('has-default');
  if (field.exprs) {
    notes.push('only' in field.exprs ? `exprs:only(${field.exprs.only.join('|')})` : `exprs:not(${field.exprs.not.join('|')})`);
  }
  return notes.length ? `[${notes.join(', ')}]` : '';
}

/** One field line: `- name: type [nullable] [write] — label: description`. The label +
 *  description are the dev's when set, else generated (see `describe-generate`). */
function describeField(field: Field, fb?: FieldBacking): string {
  const parts = [`  - ${field.name}: ${fieldTypeTag(field)}`];
  if (field.nullable) parts.push('(nullable)');
  const write = fieldWriteNote(field, fb);
  if (write) parts.push(write);
  const meta = fieldMeta(field);
  parts.push(`— ${meta.label}: ${meta.description}`);
  return parts.join(' ');
}

/**
 * One terse line describing a default condition (its soft SCOPE + how to reveal
 * past it): the dev's `description` when set, else an auto-summary
 * `default: <predicate> (unless a filter references <without fields>)`. A
 * `sql`/`run`-only, unliftable condition reads `(always applied)`. `alias` (the
 * Type name) makes the predicate render readably (`file.archivedAt IS NULL`).
 */
function defaultConditionNote(cond: DefaultCondition, alias: string): string {
  if (cond.description) return `default: ${cond.description}`;
  const built = cond.where.expr?.(alias);
  const predText = built !== undefined && typeof built !== 'boolean' ? built.toCode() : 'custom scope';
  const without = defaultConditionWithout(cond, alias);
  const lift = without.length ? ` (unless a filter references ${without.join(', ')})` : ' (always applied)';
  return `default: ${predText}${lift}`;
}

/**
 * One terse line summarizing a Type's NATURAL default order (its `defaultOrder`):
 * each term as `<key> ASC|DESC` (the key's readable `expr` form, else `custom`),
 * plus the `applyTo` scope when it is not the default `'result'`. `alias` (the
 * Type name) renders each key readably. Applied only to UNSORTED selects.
 */
function defaultOrderNote(order: DefaultOrder, alias: string): string {
  const terms = order.by
    .map((t) => {
      const built = t.by.expr?.(alias);
      const key = built ? built.toCode() : 'custom';
      return `${key} ${(t.dir ?? 'asc').toUpperCase()}`;
    })
    .join(', ');
  const scope = order.applyTo && order.applyTo !== 'result' ? `; ${order.applyTo}` : '';
  return `Default order: ${terms} (applied when unsorted${scope})`;
}

/** Render one Type as a compact description block. `backing` (when supplied) surfaces
 *  per-field write deviations (computed / default) the plain `TypeDef` can't carry, plus
 *  any soft default conditions (their scope + reveal mechanism). */
export function describeType(type: Type, backing?: TypeBacking): string {
  const lines: string[] = [];
  const meta = typeMeta(type);
  lines.push(`## ${type.name} (${meta.label})`);
  lines.push(meta.description);
  lines.push(`rows≈${type.count}, bytes/row≈${type.bytes}`);
  const write = typeWriteNote(type);
  if (write) lines.push(write);
  for (const cond of backing?.defaultConditions ?? []) lines.push(defaultConditionNote(cond, type.name));
  if (backing?.defaultOrder && backing.defaultOrder.by.length > 0) {
    lines.push(defaultOrderNote(backing.defaultOrder, type.name));
  }
  lines.push('fields:');
  for (const field of type.fields) lines.push(describeField(field, backing?.fields?.[field.name]));

  const relations = type.relationFields();
  if (relations.length > 0) {
    const rels = relations
      .map((f) => {
        const ft = f.fieldType;
        /* v8 ignore next -- `ft` is always a RelationFieldType here (relationFields() filters to it); the `: f.name` fallback is dead */
        return ft instanceof RelationFieldType ? `${f.name}→${ft.to}` : f.name;
      })
      .join(', ');
    lines.push(`relations: ${rels}`);
  }

  if (type.indexes.length > 0) {
    const idx = type.indexes
      .map((i) => {
        const cols = i.parts.map((part) => indexExprText(part.expr)).join(', ');
        const body = i.parts.length > 1 ? `(${cols})` : cols;
        return `${body}${i.unique ? ' (unique)' : ''}`;
      })
      .join(', ');
    lines.push(`indexes: ${idx}`);
  }
  return lines.join('\n');
}

/** Describe every registered (or supplied) Type, one block each. */
export function describeTypes(engine: QueryEngine | Registry, types?: readonly Type[]): string {
  const registry = toRegistry(engine);
  const list = types ?? registry.typeList();
  return list.map((t) => describeType(t, registry.backing(t.name))).join('\n\n');
}

/**
 * A one-line `name(a, b?): output — instructions` signature for one function:
 * named params (a trailing `?` marks optional), the output type, and the
 * function's terse `instructions` (Pass 1) when present.
 */
function functionSignature(fn: FunctionDef, instructions?: string): string {
  const params = fn.params.map((p) => `${p.name}${p.optional ? '?' : ''}`).join(', ');
  const out =
    fn.output === 'inferred'
      ? 'inferred'
      : 'kind' in fn.output
        ? fn.output.kind
        : fn.output.type;
  const sig = `${fn.name}(${params}): ${out}`;
  return instructions ? `${sig} — ${instructions}` : sig;
}

/**
 * One signature per function, GROUPED by shape (scalar / aggregate / window /
 * tabular). A `FunctionSelector` narrows the listing to exactly the functions
 * the in-scope schema enumerates, so the prompt and the schema agree on which
 * functions the model may call. Defaults to every registered function.
 */
export function describeFunctions(
  engine: QueryEngine | Registry,
  selector: FunctionSelector = 'all',
  maxExamples: number = DEFAULT_MAX_EXAMPLES,
  overrides: DescribeOverrides = {},
): string {
  const registry = toRegistry(engine);
  const selected = selectFunctions(registry, selector);
  // Display order: the shapes a query most often reaches for first.
  const groups: ReadonlyArray<readonly [FunctionShape, FunctionDef[]]> = [
    ['scalar', selected.scalar],
    ['aggregate', selected.aggregate],
    ['window', selected.window],
    ['tabular', selected.tabular],
  ];
  const lines: string[] = [];
  for (const [shape, fns] of groups) {
    if (fns.length === 0) continue;
    lines.push(`  ${shape}:`);
    for (const fn of fns) {
      // Functions are keyed by NAME: a caller override REPLACES the shipped docs.
      lines.push(`    - ${functionSignature(fn, overrideInstructions(fn.name, fn.instructions, overrides))}`);
      lines.push(...exampleLines(overrideExamples(fn.name, fn.examples, overrides), maxExamples, '      '));
    }
  }
  if (lines.length === 0) return 'functions: (none selected)';
  return ['functions:', ...lines].join('\n');
}

/**
 * The CAPABILITY-GATED expression catalog: one `kind — INSTRUCTIONS` line per
 * expr kind actually USABLE for the current engine's Types / functions. It
 * iterates `registry.exprClassList()` and filters by the SAME gate the schema
 * uses (`exprKindApplicable` — the always-usable core is never gated; kinds like
 * `semantic` / `array-op` appear only when an eligible Type / function exists),
 * so the prompt lists exactly the kinds the generated schema offers. `types`
 * defaults to every registered Type; `functions` narrows the shape gates.
 */
export function describeExprs(
  engine: QueryEngine | Registry,
  types?: readonly Type[],
  functions: FunctionSelector = 'all',
  maxExamples: number = DEFAULT_MAX_EXAMPLES,
  overrides: DescribeOverrides = {},
): string {
  const registry = toRegistry(engine);
  const scope = types ?? registry.typeList();
  const selected = selectFunctions(registry, functions);
  const lines: string[] = [];
  for (const c of registry.exprClassList()) {
    if (!exprKindApplicable(c.KIND, scope, selected)) continue;
    // Expr nodes are keyed by KIND: a caller override REPLACES the shipped docs.
    lines.push(`  - ${c.KIND} — ${overrideInstructions(c.KIND, c.INSTRUCTIONS, overrides)}`);
    lines.push(...exampleLines(overrideExamples(c.KIND, c.EXAMPLES, overrides), maxExamples, '    '));
  }
  return ['expressions:', ...lines].join('\n');
}

/**
 * The WORKED QUERY-EXAMPLES section: each registered query KIND that ships
 * `static EXAMPLES` (the confusing/composed ones — SELECT, UNION/INTERSECT/EXCEPT,
 * WITH/CTE), rendered as `kind — INSTRUCTIONS` plus up to `maxExamples` worked
 * example queries. These are query-LEVEL constructs (no expr catalog entry), so
 * they get their own section; the examples are the ONE source of truth on the
 * classes. Query kinds without examples (insert/update/delete/expr) are omitted.
 */
export function describeQueryExamples(
  engine: QueryEngine | Registry,
  maxExamples: number = DEFAULT_MAX_EXAMPLES,
  overrides: DescribeOverrides = {},
): string {
  const registry = toRegistry(engine);
  const lines: string[] = [];
  for (const c of registry.queryClassList()) {
    if (!c.EXAMPLES || c.EXAMPLES.length === 0) continue;
    // Query nodes are keyed by KIND: a caller override REPLACES the shipped docs.
    const instructions = overrideInstructions(c.KIND, c.INSTRUCTIONS, overrides);
    lines.push(`  ${c.KIND}${instructions ? ` — ${instructions}` : ''}`);
    lines.push(...exampleLines(overrideExamples(c.KIND, c.EXAMPLES, overrides), maxExamples, '    '));
  }
  if (lines.length === 0) return 'query examples: (none)';
  return ['query examples:', ...lines].join('\n');
}

/** The names of the registered SQL dialects. */
export function describeDialects(engine: QueryEngine | Registry): string {
  const registry = toRegistry(engine);
  const names = registry.dialectList().map((d) => d.NAME);
  return names.length > 0 ? `dialects: ${names.join(', ')}` : 'dialects: (none registered)';
}

/** Options for `describeEngine` — narrow the Types and/or the function listing. */
export interface DescribeEngineOptions {
  /** The Types to describe + gate against; defaults to every registered Type. */
  types?: readonly Type[];
  /** Narrows the function listing + shape gating to the schema's selection. */
  functions?: FunctionSelector;
  /**
   * Cap on WORKED examples rendered PER function and PER node (expr kind / query
   * kind). Keeps the composed docs terse. Defaults to {@link DEFAULT_MAX_EXAMPLES};
   * `0` omits examples entirely.
   */
  maxExamples?: number;
  /**
   * BRING-YOUR-OWN INSTRUCTIONS: `name/kind → instruction line` that REPLACES the
   * shipped `INSTRUCTIONS` for that function (by NAME) / expr / query node (by KIND).
   * Absent keys keep the shipped default; an absent / empty map changes nothing.
   */
  instructions?: Record<string, string>;
  /**
   * BRING-YOUR-OWN EXAMPLES: `name/kind → raw-JSON example strings` that REPLACE the
   * shipped `EXAMPLES` for that function (by NAME) / expr / query node (by KIND) —
   * e.g. examples written against your OWN domain Types. Still capped by
   * `maxExamples`. Examples are rendered VERBATIM (validate them yourself — a bare
   * `createRegistry().parseCheckedQuery` / `parseCheckedExpr` mirrors the shipped
   * check). Absent keys keep the shipped default; an absent / empty map changes nothing.
   */
  examples?: Record<string, readonly string[]>;
}

/**
 * Full capability summary a model can read to know EVERYTHING it may use: every
 * (supplied) Type with its generated/overridden docs, the usable expr kinds with
 * their worked examples (`describeExprs`), the selected functions with their
 * worked examples (`describeFunctions`), the worked query-examples section
 * (`describeQueryExamples`), and the registered dialects. `functions` narrows the
 * expr gating + function listing to the same selection the schema enumerates
 * (defaults to all); `maxExamples` caps examples per node / function. `instructions`
 * / `examples` let a caller REPLACE the shipped INSTRUCTIONS / EXAMPLES for any
 * function (by name) or node (by kind) with their OWN — e.g. examples written
 * against their domain Types — while every un-overridden item keeps the shipped default.
 */
export function describeEngine(
  engine: QueryEngine | Registry,
  options: DescribeEngineOptions = {},
): string {
  const { types, functions = 'all', maxExamples = DEFAULT_MAX_EXAMPLES, instructions, examples } = options;
  // One flat override namespace threads to every render path (functions by name,
  // expr / query nodes by kind); shipped INSTRUCTIONS / EXAMPLES remain the fallback.
  const overrides: DescribeOverrides = { instructions, examples };
  return [
    describeTypes(engine, types),
    describeExprs(engine, types, functions, maxExamples, overrides),
    describeFunctions(engine, functions, maxExamples, overrides),
    describeQueryExamples(engine, maxExamples, overrides),
    describeDialects(engine),
  ].join('\n\n');
}
