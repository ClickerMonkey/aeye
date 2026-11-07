import { describe, test, expect } from 'vitest';
import { buildSchemas, createRegistry, isTypeName, typeClosure, typeReferences, TYPE_NAME, type TypeDef } from '../index';

/**
 * Type names may be namespaced (`fs/Entry`, `my-app/billing/Invoice`), so a
 * host loading types from several sources keeps them apart without escaping
 * names into `\w+` and back. Junk is still refused.
 */
describe('qualified type names', () => {
  test('the name rule takes identifiers and namespaced identifiers only', () => {
    for (const ok of ['Entry', 'text', 'fs/Entry', 'my-app/Thing', 'a/b/C', 'x_1/Y_2']) {
      expect(isTypeName(ok), ok).toBe(true);
    }
    for (const bad of ['', ' Entry', 'Entry ', 'fs/', '/Entry', 'fs//Entry', 'fs/my-Thing', 'fs.Entry', 'a b', 'fs/Entry.reveal', 42, undefined]) {
      expect(isTypeName(bad), String(bad)).toBe(false);
    }
    expect(TYPE_NAME.test('fs/Entry')).toBe(true);
  });

  test('registry.parse takes a namespaced name, extends and satisfies, and round-trips them', () => {
    const r = createRegistry();
    const def: TypeDef = { name: 'shop/Product', extends: 'obj', props: { sku: { type: { name: 'text' } } } };
    const t = r.parse(def);
    expect(t.name).toBe('shop/Product');
    expect(t.toJSON()).toEqual(def);
    expect(t.parse({ sku: 'a1' }).toLogical()).toEqual({ sku: 'a1' });
  });

  test('registry.parse still refuses junk names with a pointer to the rule', () => {
    const r = createRegistry();
    expect(() => r.parse({ name: ' fs/Entry', extends: 'obj', props: {} } as TypeDef)).toThrow(/type 'name' must match/);
    expect(() => r.parse({ name: 'fs/Entry', extends: 'o bj', props: {} } as TypeDef)).toThrow(/type 'extends' must match/);
    expect(() => r.parse({ name: 'fs/Entry', extends: 'obj', satisfies: ['a b'], props: {} } as TypeDef)).toThrow(/'satisfies' entries must match/);
  });

  test('references, closure and scope binding work on namespaced names as they stand', () => {
    const r = createRegistry();
    const defs = new Map<string, TypeDef>([
      ['fs/Entry', { name: 'fs/Entry', extends: 'obj', props: { path: { type: { name: 'text' } }, parent: { type: { name: 'optional', generic: { T: { name: 'fs/Dir' } } } } } }],
      ['fs/Dir', { name: 'fs/Dir', extends: 'obj', props: { path: { type: { name: 'text' } } } }],
    ]);
    const listing: TypeDef = { name: 'list', generic: { V: { name: 'fs/Entry' } } };
    expect(typeReferences(listing, r).refs).toEqual(['fs/Entry']);
    const closure = typeClosure([listing], r, (name) => defs.get(name));
    expect(closure.order).toEqual(['fs/Dir', 'fs/Entry']);
    expect(closure.missing).toEqual([]);
    const scope = r.scope();
    for (const name of closure.order) scope.bind(name, scope.parse(closure.defs.get(name)!));
    const t = scope.parse(listing);
    expect(t.parse([{ path: '/a', parent: { path: '/' } }]).toLogical()).toEqual([{ path: '/a', parent: { path: '/' } }]);
    expect(() => t.parse([{ path: 1 }])).toThrow();
    expect(t.toJSONRef({ form: 'envelope', typeRefs: 'name' })).toEqual(listing);
  });

  test('the extension schema an LLM writes against accepts a namespaced name', () => {
    const r = createRegistry();
    const schema = buildSchemas(r).Type;
    expect(schema.safeParse({ name: 'shop/Product', extends: 'obj', props: {} }).success).toBe(true);
    expect(schema.safeParse({ name: 'shop Product', extends: 'obj', props: {} }).success).toBe(false);
  });
});
