/**
 * Compact, LLM-facing descriptions of the query meta-model.
 *
 * `describeType(type)` renders one Type as a short block an LLM can read to
 * understand what it may query: the Type's name / label / description, then
 * each field (name, type, nullability, label, description), then its
 * relations and indexes. `describeEngine(engine)` summarizes everything a
 * caller can use — every registered Type plus the available functions and SQL
 * dialects — and `exampleQueriesText()` returns ready-to-paste example query
 * JSON for a tool's prompt.
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

/** One field line: `- name: type [nullable] — label/description`. */
function describeField(field: Field): string {
  const parts = [`  - ${field.name}: ${fieldTypeTag(field)}`];
  if (field.nullable) parts.push('(nullable)');
  const docs = field.label ?? field.description;
  if (docs) parts.push(`— ${docs}`);
  return parts.join(' ');
}

/** Render one Type as a compact description block. */
export function describeType(type: Type): string {
  const lines: string[] = [];
  const header = type.label ? `${type.name} (${type.label})` : type.name;
  lines.push(`## ${header}`);
  if (type.description) lines.push(type.description);
  lines.push(`rows≈${type.count}, bytes/row≈${type.bytes}`);
  lines.push('fields:');
  for (const field of type.fields) lines.push(describeField(field));

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
  return list.map(describeType).join('\n\n');
}

/** A one-line `name(params): output` signature for one function. */
function functionSignature(fn: FunctionDef): string {
  const params = fn.params
    .map((p) => `${p.name}: ${p.type === 'any' ? 'any' : p.type.kind}${p.optional ? '?' : ''}`)
    .join(', ');
  const out =
    fn.output === 'inferred'
      ? 'inferred'
      : 'kind' in fn.output
        ? fn.output.kind
        : fn.output.type;
  return `${fn.name}(${params}): ${out}`;
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

/** The names of the registered SQL dialects. */
export function describeDialects(engine: QueryEngine | Registry): string {
  const registry = toRegistry(engine);
  const names = registry.dialectList().map((d) => d.NAME);
  return names.length > 0 ? `dialects: ${names.join(', ')}` : 'dialects: (none registered)';
}

/**
 * Full capability summary: every (supplied) Type, plus the selected functions
 * and the registered dialects. `functions` narrows the function listing to the
 * same selection the schema enumerates (defaults to all).
 */
export function describeEngine(
  engine: QueryEngine | Registry,
  types?: readonly Type[],
  functions: FunctionSelector = 'all',
): string {
  return [
    describeTypes(engine, types),
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
