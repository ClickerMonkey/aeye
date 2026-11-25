/**
 * Pieces of the `a` grammar (grammar.ts) that value schemas need too
 * (`TypType.valueA` narrows a TypeDef to the classes that fit its
 * constraint). Kept apart from grammar.ts so the type classes can import
 * them without importing the grammar module.
 */
import { a, type AnySchema } from '@aeye/schema';
import type { Registry } from './registry';
import { TYPE_NAME } from './type-name';

/** The grammar's def name per built-in type class (gin's aids: obj → Type_object, fn → Type_function). */
export const BUILTIN_TYPE_AIDS: Readonly<Record<string, string>> = {
  any: 'Type_any', void: 'Type_void', null: 'Type_null', bool: 'Type_bool', num: 'Type_num', text: 'Type_text', list: 'Type_list',
  map: 'Type_map', tuple: 'Type_tuple', obj: 'Type_object', optional: 'Type_optional', nullable: 'Type_nullable', not: 'Type_not',
  or: 'Type_or', and: 'Type_and', enum: 'Type_enum', literal: 'Type_literal', fn: 'Type_function', interface: 'Type_interface',
  typ: 'Type_typ', date: 'Type_date', timestamp: 'Type_timestamp', duration: 'Type_duration', color: 'Type_color',
};

/** A type NAME (gin's TYPE_NAME): an identifier, optionally namespaced (`ns/Name`). */
export const typeNameA = () => a.string().pattern(TYPE_NAME.source).describe('A type name: an identifier, optionally namespaced as ns/Name.');

/**
 * The TypeDef branch for a type name: a built-in class's def (a ref into the
 * grammar), a registered class's own `static toA()` (or a loose
 * `{ name }` object), or a registered named type by name (other keys pass).
 */
export function typeBranchA(registry: Registry, name: string): AnySchema {
  const aid = BUILTIN_TYPE_AIDS[name];
  const cls = registry.typeClass(name);
  if (cls !== undefined && aid !== undefined && registry.namedTypeList().every((t) => t.name !== name)) return a.ref(aid);
  if (cls !== undefined) return cls.toA?.() ?? a.object({ name: a.literal(name) });
  return a.object({ name: a.literal(name) });
}

/** A named type by its name alone (`namedRefs`); the name is checked when the TypeDef is parsed. */
export function namedRefA(): AnySchema {
  return a.object({ name: typeNameA() }).strict().describe('A named type, by its name.');
}

/**
 * The Extension TypeDef: a NEW named type atop one of `baseNames` (with no
 * names its `extends` takes nothing, which disables the branch).
 */
export function extensionA(baseNames: readonly string[]): AnySchema {
  return a.object({
    name: typeNameA(),
    extends: baseNames.length > 0 ? a.enum([...new Set(baseNames)]) : a.never(),
    docs: a.string().optional(),
    satisfies: a.array(typeNameA()).optional(),
    generic: a.ref('Generic').optional(),
    options: a.record(a.unknown()).optional(),
    props: a.record(a.ref('PropDef')).optional(),
    get: a.ref('GetSetDef').optional(),
    call: a.ref('CallDef').optional(),
    init: a.ref('InitDef').optional(),
    constraint: a.ref('Expr').optional(),
  }).describe('A NEW named type declared inline: a name, the type it extends, and what it adds.');
}
