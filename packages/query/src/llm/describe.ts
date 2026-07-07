/**
 * Compact, LLM-facing descriptions of the query meta-model.
 *
 * `describeType(type)` renders one Type as a short block an LLM can read to
 * understand what it may query: the Type's name / label / description, then
 * each field (name, type, nullability, label, description), then its
 * relations and indexes. `describeExprs(engine)` lists the CAPABILITY-GATED
 * expression kinds usable for the current Types / functions (each with its
 * `static INSTRUCTIONS`). `describeEngine(engine)` composes everything a caller
 * can use — every registered Type, the usable expr kinds, the available
 * functions, and the SQL dialects — into one block; `exampleQueriesText()`
 * returns ready-to-paste example query JSON for a tool's prompt.
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
import { RelationFieldType, TextFieldType, MoneyFieldType } from '../field-types/index';
import { hasFieldDefault, type DefaultCondition, type DefaultOrder, type FieldBacking, type TypeBacking } from '../backing';
import { defaultConditionWithout } from '../default-conditions';
import { exprKindApplicable } from '../schema-build';
import { fieldMeta, typeMeta } from './describe-generate';
import { selectFunctions, type FunctionSelector } from './schemas';

/** A readable label for an index's stored `ExprDef` (raw JSON this phase). */
function indexExprText(expr: ExprDef): string {
  if (expr.kind === 'field-ref') return `${expr.source}.${expr.field}`;
  return expr.kind;
}

/** Narrow a `QueryEngine | Registry` to its `Registry` without a cast. */
function toRegistry(engineOrRegistry: QueryEngine | Registry): Registry {
  return 'registry' in engineOrRegistry ? engineOrRegistry.registry : engineOrRegistry;
}

/** A short type tag for one field, e.g. `money(USD)` or `relation→order×12`. */
function fieldTypeTag(field: Field): string {
  const ft = field.fieldType;
  if (ft instanceof RelationFieldType) {
    return `relation→${ft.to}×${ft.count}`;
  }
  if (ft instanceof MoneyFieldType) {
    return ft.options.currency ? `money(${ft.options.currency})` : 'money';
  }
  if (ft instanceof TextFieldType) {
    const flags: string[] = [];
    if (ft.options.search) flags.push('search');
    if (ft.options.semantic) flags.push('semantic');
    return flags.length ? `text(${flags.join(',')})` : 'text';
  }
  return ft.kind;
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
function functionSignature(fn: FunctionDef): string {
  const params = fn.params.map((p) => `${p.name}${p.optional ? '?' : ''}`).join(', ');
  const out =
    fn.output === 'inferred'
      ? 'inferred'
      : 'kind' in fn.output
        ? fn.output.kind
        : fn.output.type;
  const sig = `${fn.name}(${params}): ${out}`;
  return fn.instructions ? `${sig} — ${fn.instructions}` : sig;
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
    for (const fn of fns) lines.push(`    - ${functionSignature(fn)}`);
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
): string {
  const registry = toRegistry(engine);
  const scope = types ?? registry.typeList();
  const selected = selectFunctions(registry, functions);
  const lines = registry
    .exprClassList()
    .filter((c) => exprKindApplicable(c.KIND, scope, selected))
    .map((c) => `  - ${c.KIND} — ${c.INSTRUCTIONS}`);
  return ['expressions:', ...lines].join('\n');
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
}

/**
 * Full capability summary a model can read to know EVERYTHING it may use: every
 * (supplied) Type with its generated/overridden docs, the usable expr kinds
 * (`describeExprs`), the selected functions (`describeFunctions`), and the
 * registered dialects. `functions` narrows the expr gating + function listing to
 * the same selection the schema enumerates (defaults to all).
 */
export function describeEngine(
  engine: QueryEngine | Registry,
  options: DescribeEngineOptions = {},
): string {
  const { types, functions = 'all' } = options;
  return [
    describeTypes(engine, types),
    describeExprs(engine, types, functions),
    describeFunctions(engine, functions),
    describeDialects(engine),
  ].join('\n\n');
}

/**
 * A small set of example query JSON snippets to seed an LLM tool's prompt.
 * Sources are referenced by their Type name (`from: { kind: 'type', type:
 * 'user' }`, `field-ref.source: 'user'`) — strict-mode field refs are
 * Type+field pairs, so the source IS the Type name. Substitute the Types you
 * actually have.
 */
export function exampleQueriesText(): string {
  return [
    'Field references pair a Type with one of its fields: the source IS the',
    'Type name (`from: { kind: "type", type: "user" }`, then `field-ref.source: "user"`).',
    '',
    'Example — select with a filter and limit:',
    '```json',
    JSON.stringify(
      {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
        from: { kind: 'type', type: 'user' },
        where: [
          {
            kind: 'comparison',
            op: '>',
            left: { kind: 'field-ref', source: 'user', field: 'age' },
            right: { kind: 'literal', value: 30 },
          },
        ],
        limit: 10,
      },
      null,
      2,
    ),
    '```',
    '',
    'Example — aggregate (revenue per user):',
    '```json',
    JSON.stringify(
      {
        kind: 'select',
        fields: [
          { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
          {
            expr: {
              kind: 'aggregate',
              function: 'sum',
              args: { value: { kind: 'field-ref', source: 'order', field: 'total' } },
            },
            as: 'revenue',
          },
        ],
        from: { kind: 'type', type: 'order' },
        groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
      },
      null,
      2,
    ),
    '```',
    '',
    'Functions take NAMED arguments keyed by the declared parameter name',
    '(`{ function: "upper", args: { value: … } }`); `count(*)` is `count` with',
    'empty `args`:',
    '```json',
    JSON.stringify(
      {
        kind: 'select',
        fields: [
          {
            expr: {
              kind: 'function-call',
              function: 'upper',
              args: { value: { kind: 'field-ref', source: 'user', field: 'name' } },
            },
            as: 'shout',
          },
        ],
        from: { kind: 'type', type: 'user' },
      },
      null,
      2,
    ),
    '```',
    '',
    'A JOIN crosses a SINGLE relation field — `on` is `{ source, field }` (the',
    'bound source + its relation field); the joined rows bind under the target',
    "Type name. Chain joins for multi-hop. A `filters` placeholder is just",
    '`{ source, fields? }` (clauses are supplied at execution time, never here);',
    'semantic / text-search take `{ source, field?, query }`:',
    '```json',
    JSON.stringify(
      {
        kind: 'select',
        fields: [
          { expr: { kind: 'field-ref', source: 'user', field: 'name' } },
          { expr: { kind: 'field-ref', source: 'order', field: 'total' } },
        ],
        from: { kind: 'type', type: 'user' },
        joins: [{ on: { source: 'user', field: 'orders' } }],
        where: [{ kind: 'filters', source: 'order', fields: ['total'] }],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}
