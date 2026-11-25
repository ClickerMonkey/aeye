/**
 * What ginny's `a` schemas share: the ctx the gin grammar binds with, and
 * the value schema of a TypeDef the model just wrote (create_var's `value`).
 */
import type { AnySchema } from '@aeye/schema';
import type { Registry } from '@aeye/gin';

/** The part of ginny's ctx a grammar-typed schema reads (bound per registry version). */
export interface GrammarCtx {
  readonly registry: Registry;
}

/**
 * The value schema of a TypeDef written beside the value (`.dependent`): the
 * def parsed by gin and its `toA()`. A def gin can't parse leaves the value
 * unchecked here (the def itself is what's reported).
 */
export function valueSchemaFor(registry: Registry): (def: unknown) => AnySchema | undefined {
  let cache = valueSchemas.get(registry);
  if (!cache) valueSchemas.set(registry, (cache = new Map()));
  const memo = cache;
  return (def) => {
    if (typeof def !== 'object' || def === null) return undefined;
    // One schema instance per def (the bind compiles each instance once).
    const key = `${registry.version}|${JSON.stringify(def)}`;
    if (memo.has(key)) return memo.get(key);
    let s: AnySchema | undefined;
    try {
      s = registry.parse(def).toA();
    } catch {
      s = undefined;
    }
    if (memo.size >= 256) memo.delete(memo.keys().next().value!);
    memo.set(key, s);
    return s;
  };
}

const valueSchemas = new WeakMap<Registry, Map<string, AnySchema | undefined>>();
