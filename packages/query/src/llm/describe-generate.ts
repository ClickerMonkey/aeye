/**
 * On-demand DEFAULT `label` (short) + `description` (long) generation for Types
 * and Fields.
 *
 * A developer-supplied `label` / `description` ALWAYS wins; these fill the gap
 * so every Type / Field surfaces a human- / LLM-facing doc even when the dev
 * authored none. Values are derived from what the meta-model already knows — a
 * Field from its `FieldType` (kind, bounds, `sensitive` / `semantic` / `search`
 * flags, array item / bounds, a relation's `to` + `count`, nullability) and a
 * Type from its name plus a field / relation / index summary.
 *
 * NOTHING here mutates the stored `TypeDef` / `FieldDef`: each string is
 * computed FRESH per call, so this is safe for rendering and introspection.
 */
import type { Type } from '../type';
import type { Field } from '../field';
import type { FieldType } from '../field-type';
import type { FieldTypeDef } from '../schema';

/** A short/long documentation pair (dev-provided when present, else generated). */
export interface Meta {
  /** Short human-readable label (one phrase). */
  label: string;
  /** Longer, one-line human / LLM-facing description. */
  description: string;
}

/**
 * Humanize an identifier into a Title-Case phrase: split camelCase / snake_case
 * / kebab-case boundaries and capitalize each word, dropping a trailing `Id`
 * suffix (a key convention). `parentId` → "Parent", `unit_price` → "Unit
 * Price", `user` → "User".
 */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  if (words.length > 1 && words[words.length - 1] === 'Id') words.pop();
  return words.join(' ') || name;
}

/** A ` (lo–hi)` / ` (≥ lo)` / ` (≤ hi)` bound suffix, empty when unbounded. */
function boundSuffix(lo: number | undefined, hi: number | undefined, unit: string): string {
  if (lo !== undefined && hi !== undefined) return ` (${lo}–${hi}${unit})`;
  if (lo !== undefined) return ` (≥ ${lo}${unit})`;
  if (hi !== undefined) return ` (≤ ${hi}${unit})`;
  return '';
}

/**
 * A one-line sentence for a field type, derived from its JSON `FieldTypeDef`
 * (whose discriminated `kind` narrows every branch with no cast). Never ends
 * with punctuation — the caller appends it.
 */
function fieldTypeSentence(ft: FieldType): string {
  const def: FieldTypeDef = ft.toJSON();
  switch (def.kind) {
    case 'number':
      return (def.whole ? 'A whole number' : 'A number') + boundSuffix(def.min, def.max, '');
    case 'money':
      return def.currency ? `A monetary amount in ${def.currency}` : 'A monetary amount';
    case 'text': {
      const flags: string[] = [];
      if (def.search) flags.push('full-text searchable');
      if (def.semantic) flags.push('semantic-search eligible');
      if (def.sensitive) flags.push('case-sensitive');
      return flags.length > 0 ? `Text (${flags.join(', ')})` : 'Text';
    }
    case 'bool':
      return 'A true/false flag';
    case 'relation':
      return def.count === 1
        ? `Belongs to one ${def.to}`
        : `Has many ${def.to} (≈${def.count} per row)`;
    case 'date':
      return 'A calendar date';
    case 'timestamp':
      return 'A date and time';
    case 'json':
      return 'A JSON document';
    case 'array': {
      const item = def.item ? ` of ${def.item.kind}` : '';
      return `A list${item}${boundSuffix(def.minItems, def.maxItems, ' items')}`;
    }
    /* v8 ignore next 2 -- unreachable: `def.kind` exhaustively covers the nine field-type kinds */
    default:
      return assertNeverFieldType(def);
  }
}

/** The generated short label for a field: its humanized name. */
export function generatedFieldLabel(field: Field): string {
  return humanize(field.name);
}

/** The generated long description for a field: its type sentence + nullability. */
export function generatedFieldDescription(field: Field): string {
  const base = fieldTypeSentence(field.fieldType);
  return field.nullable ? `${base}. Optional (may be null).` : `${base}.`;
}

/** The generated short label for a Type: its humanized name. */
export function generatedTypeLabel(type: Type): string {
  return humanize(type.name);
}

/**
 * The generated long description for a Type: its humanized name plus a compact
 * field / relation / index summary, row estimate, and any search capability.
 */
export function generatedTypeDescription(type: Type): string {
  const rels = type.relationFields().length;
  const bits: string[] = [`${type.fields.length} fields`];
  if (rels > 0) bits.push(`${rels} relations`);
  if (type.indexes.length > 0) bits.push(`${type.indexes.length} indexes`);
  const caps: string[] = [];
  if (type.isSearchable()) caps.push('full-text');
  if (type.isSemantic()) caps.push('semantic');
  if (caps.length > 0) bits.push(`${caps.join('/')} searchable`);
  return `${humanize(type.name)}: ${bits.join(', ')}; ~${type.count} rows.`;
}

/**
 * The short + long docs for a field — the developer's `label` / `description`
 * when set, otherwise the generated defaults. Read-only: the stored def is
 * untouched.
 */
export function fieldMeta(field: Field): Meta {
  return {
    label: field.label ?? generatedFieldLabel(field),
    description: field.description ?? generatedFieldDescription(field),
  };
}

/**
 * The short + long docs for a Type — the developer's `label` / `description`
 * when set, otherwise the generated defaults. Read-only: the stored def is
 * untouched.
 */
export function typeMeta(type: Type): Meta {
  return {
    label: type.label ?? generatedTypeLabel(type),
    description: type.description ?? generatedTypeDescription(type),
  };
}

/* v8 ignore start -- compile-time exhaustiveness guard; never invoked at runtime */
/** Compile-time exhaustiveness guard over the `FieldTypeDef` union. */
function assertNeverFieldType(value: never): never {
  throw new Error(`describe-generate: unhandled field-type ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
