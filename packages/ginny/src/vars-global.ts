import { Value } from '@aeye/gin';
import type { Ctx } from './context';

/**
 * Names of vars whose in-memory state has diverged from disk since the
 * last successful flush. Module-level so the set survives across
 * `engine.run` calls within a single ginny session — `flushDirtyVars`
 * is the only thing that clears it.
 *
 * Mutation is detected via two layers of `Proxy`:
 *
 *   1. `wrapValueDeep` rewires each loaded `Value`'s `.raw` to be a
 *      Proxy. Any `set` / `deleteProperty` on that raw — including
 *      array methods like `push` / `splice` that internally assign to
 *      indexed slots — marks the owning var dirty. The wrapper recurses
 *      into composite raws so nested mutations (`vars.config.theme =
 *      "dark"`, `vars.matrix[0][0] = 5`) are caught at any depth.
 *
 *   2. The `vars` record itself is wrapped in `refreshVarsGlobal` so
 *      whole-var replacements (`vars.counter = vars.counter + 1`) mark
 *      the slot dirty AND deep-wrap the new `Value` so any subsequent
 *      mutation on it is also tracked.
 *
 * Encoding a wrapped Value (for the disk write) only reads through the
 * proxy, so the on-disk representation is unaffected by the wrapping.
 */
const dirty = new Set<string>();

/** Values whose raw has already been proxied — avoids double-wrap if a
 *  Value is reachable via more than one path. */
const proxied = new WeakSet<Value>();

function wrapValueDeep(value: Value, mark: () => void): void {
  if (proxied.has(value)) return;
  proxied.add(value);

  const raw = value.raw as unknown;
  if (!raw || typeof raw !== 'object') return;

  // Recurse into existing inner Values first so the leaves are wrapped
  // before we install the parent proxy.
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item instanceof Value) wrapValueDeep(item, mark);
    }
  } else {
    for (const item of Object.values(raw as Record<string, unknown>)) {
      if (item instanceof Value) wrapValueDeep(item, mark);
    }
  }

  const proxy = new Proxy(raw as object, {
    set(target, prop, val, recv) {
      mark();
      // A freshly-created Value (e.g. pushed via `vars.tasks.push(t)`)
      // arrives with an unwrapped raw — wrap it now so deep mutations
      // through it are tracked too.
      if (val instanceof Value) wrapValueDeep(val, mark);
      return Reflect.set(target, prop, val, recv);
    },
    deleteProperty(target, prop) {
      mark();
      return Reflect.deleteProperty(target, prop);
    },
  });

  // `Value.raw` is declared readonly in TypeScript but isn't frozen at
  // runtime — swapping in the proxy is the cheapest way to keep Value
  // identity stable while routing all access through the proxy.
  (value as { raw: unknown }).raw = proxy;
}

export function refreshVarsGlobal(ctx: Ctx): void {
  const props: Record<string, { type: any; docs?: string }> = {};
  const value: Record<string, Value> = {};
  for (const [name, { type, parsed, docs }] of ctx.loadedVars) {
    props[name] = { type, docs };
    value[name] = parsed;
  }
  const varsType = ctx.registry.obj(props);

  const valueProxy = new Proxy(value, {
    set(target, prop, val, recv) {
      if (typeof prop === 'string') {
        dirty.add(prop);
        if (val instanceof Value) {
          wrapValueDeep(val, () => dirty.add(prop));
          // Replacement: keep `loadedVars` in sync so the flush writes
          // the new Value, not the stale one we loaded from disk.
          const existing = ctx.loadedVars.get(prop);
          if (existing) ctx.loadedVars.set(prop, { ...existing, parsed: val });
        }
      }
      return Reflect.set(target, prop, val, recv);
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string') dirty.add(prop);
      return Reflect.deleteProperty(target, prop);
    },
  });

  ctx.engine.registerGlobal('vars', { type: varsType, value: valueProxy });
}

export function loadVarInto(ctx: Ctx, name: string): void {
  if (ctx.loadedVars.has(name)) return;
  const def = ctx.store.readVar(name);
  const type = ctx.registry.parse(def.type);
  const parsed = type.parse(def.value);
  wrapValueDeep(parsed, () => dirty.add(name));
  ctx.loadedVars.set(name, { type, parsed, docs: def.docs });
  refreshVarsGlobal(ctx);
}

/**
 * Persist every var marked dirty since the last flush, and clear the
 * dirty set. Called from `test()` after a successful run; encoding goes
 * through `Value.encode()` which reads the proxied raw transparently.
 *
 * Returns the names that were written so the caller can surface them.
 */
export function flushDirtyVars(ctx: Ctx): string[] {
  if (dirty.size === 0) return [];
  const written: string[] = [];
  for (const name of dirty) {
    const entry = ctx.loadedVars.get(name);
    if (!entry) continue;
    try {
      ctx.store.writeVar(name, {
        type: entry.type.toJSON(),
        value: entry.parsed.encode(),
        docs: entry.docs,
      });
      written.push(name);
    } catch {
      // Leave the var dirty — next successful run will retry.
    }
  }
  for (const name of written) dirty.delete(name);
  return written;
}
