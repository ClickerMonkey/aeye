/**
 * On-demand DEFAULT `label` (short) + `description` (long) generation for Types
 * and Fields.
 *
 * A developer-supplied `label` / `description` ALWAYS wins; these fill the gap
 * so every Type / Field surfaces a human- / LLM-facing doc even when the dev
 * authored none. Values are derived from what the meta-model already knows — a
 * Field from its `FieldType` (kind, bounds, `casing` / `semantic` / `search`
 * flags, array item / bounds, a relation's `to` + DIRECTION + `count`, nullability) and a
 * Type from its name plus a field / relation / index summary.
 *
 * NOTHING here mutates the stored `TypeDef` / `FieldDef`: each string is
 * computed FRESH per call, so this is safe for rendering and introspection.
 */
import type { Type } from '../type';
import type { Field } from '../field';
import type { FieldType } from '../field-type';
import { RelationFieldType } from '../field-types/index';
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
 * (whose discriminated `kind` narrows every branch with no cast) — except the
 * relation branch, which must ask the `FieldType` for its DIRECTION because the
 * discriminating `inverseVia` is internal and never serialized. Never ends
 * with punctuation — the caller appends it.
 */
function fieldTypeSentence(ft: FieldType): string {
  // A REFINEMENT's own `instructions` are what its declarer wrote FOR a model to
  // read; a generated sentence describes the BASE and would say strictly less
  // ("Text" for a uuid). Required at registration, so this is never empty — and
  // trimmed of a trailing stop because the caller appends one.
  const instructions = ft.refinement?.instructions;
  if (instructions !== undefined) return instructions.trim().replace(/\.+$/, '');
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
      // The DECLARED casing only. A field that declares none inherits the
      // engine's default, which this road cannot see (it is handed a
      // `FieldType`, not an engine). The model needs to know whether case
      // MATTERS, not which side performs the fold, so `collated` and `fold`
      // describe the same behaviour to it.
      if (def.casing !== undefined) flags.push(def.casing === 'exact' ? 'case-sensitive' : 'case-insensitive');
      return flags.length > 0 ? `Text (${flags.join(', ')})` : 'Text';
    }
    case 'bool':
      return 'A true/false flag';
    case 'relation': {
      // WHICH SIDE the key is on is `isBelongsTo()`, never `count` alone: the
      // registry estimates a MATERIALIZED INVERSE's count as a row RATIO, so a
      // 1:1 pair — or two Types sharing one declared row estimate — yields
      // exactly 1. Reading `count === 1` here therefore described every such
      // inverse to the model as a BELONGS-TO, i.e. as a projectable identity
      // it does not have (a field-ref to it is refused as
      // `ref.relation-has-many`). The discriminating `inverseVia` is internal
      // and never part of the JSON def, so this one branch asks the FieldType.
      /* v8 ignore next -- `def.kind === 'relation'` ⇒ `ft` is always a RelationFieldType; the `def.count` arm is unreachable */
      const belongsTo = ft instanceof RelationFieldType ? ft.isBelongsTo() : def.count === 1;
      return belongsTo ? `Belongs to one ${def.to}` : `Has many ${def.to} (≈${def.count} per row)`;
    }
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
    default: {
      // COMPILE-time exhaustiveness, without a RUNTIME throw.
      //
      // `def.kind` is `never` here for as long as the nine branches above cover
      // the union, so a TENTH builtin kind stops compiling at this line — which
      // is the guarantee the old `assertNeverFieldType` was there for. But the
      // union is not the only thing that reaches this switch: a registry can
      // carry a field-type class the package does not ship, and its def's `kind`
      // is then outside the union at runtime. Throwing made that a live crash on
      // an ordinary road — `describeType()` generates a description for every
      // field that has none — so the fallback is the type's own `toCode()`,
      // which is exactly the "say what you can" answer this module exists for.
      const exhaustive: never = def;
      void exhaustive;
      return ft.toCode();
    }
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

