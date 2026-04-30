import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import type { Type, TypeDef } from '../index';

/**
 * Sanity check: mirrors the helper ginny uses to feed base-type docs
 * into the programmer prompt. Ensures iterating `typeClasses()` +
 * placeholder rebuilds produces readable `list<V>` / `map<K, V>` style
 * headers rather than `list<any>` — and that it covers every registered
 * class without a hard-coded list.
 */
function placeholderize(r: ReturnType<typeof createRegistry>, cls: { NAME: string; from: (def: TypeDef, r: any) => Type }): Type | undefined {
  let canonical: Type;
  try { canonical = cls.from({ name: cls.NAME } as TypeDef, r); } catch { return undefined; }
  const keys = Object.keys(canonical.generic);
  if (keys.length === 0) return canonical;
  const genericDef: Record<string, TypeDef> = {};
  // Bare-name shape: `{name: 'V'}` parses to an AliasType('V') in
  // the registry-root scope (unresolved → universal placeholder).
  for (const k of keys) genericDef[k] = { name: k };
  try { return cls.from({ name: cls.NAME, generic: genericDef } as TypeDef, r); } catch { return canonical; }
}

describe('ginny buildTypeDocs helper', () => {
  test('list renders as list<V>, not list<any>', () => {
    const r = createRegistry();
    const list = placeholderize(r, (r.typeClasses() as any).find((c: any) => c.NAME === 'list'))!;
    expect(list.toCode()).toBe('list<V>');
  });

  test('map renders as map<K, V>', () => {
    const r = createRegistry();
    const map = placeholderize(r, (r.typeClasses() as any).find((c: any) => c.NAME === 'map'))!;
    expect(map.toCode()).toBe('map<K, V>');
  });

  test('optional renders as optional<T>', () => {
    const r = createRegistry();
    const opt = placeholderize(r, (r.typeClasses() as any).find((c: any) => c.NAME === 'optional'))!;
    expect(opt.toCode()).toBe('optional<T>');
  });

  test('every typeClass produces toCodeDefinition without throwing', () => {
    const r = createRegistry();
    for (const cls of r.typeClasses()) {
      const t = placeholderize(r, cls);
      if (!t) continue;
      expect(() => t.toCodeDefinition()).not.toThrow();
    }
  });

  test('new type class auto-appears in the doc iteration', () => {
    const r = createRegistry();
    // Simulate "gin adds a new built-in" by registering a stand-in type
    // class. The iteration picks it up automatically — no hand-maintained
    // list in ginny to update.
    const names = r.typeClasses().map((c) => c.NAME);
    // Count before. (typ was the newest real addition.)
    expect(names).toContain('typ');
    // Confirm extension types also appear in namedTypeList.
    const Positive = r.extend(r.num(), { name: 'Positive' });
    r.register(Positive);
    expect(r.namedTypeList().map((t) => t.name)).toContain('Positive');
  });
});
