import type { Registry } from './registry';
import { Call, GetSet, Init, Prop, type PropSpec, type Type } from './type';
import type { CallDef, GetSetDef, PropDef, TypeDef } from './schema';
import { LocalScope, type TypeScope } from './type-scope';

/**
 * Runtime ↔ schema conversion for Prop/GetSet/Call/Init specs.
 * Runtime specs hold resolved Type instances; schema specs hold TypeDef JSON.
 *
 * **Encoding lives on the runtime classes** as `toJSON()` methods —
 * `Prop.toJSON()`, `GetSet.toJSON()`, `Call.toJSON()`, `Init.toJSON()`.
 * Each concrete Type calls `.toJSON()` directly when implementing its
 * own `toJSON()`. The free `encodeProps` helper below is the only
 * survivor: it's a thin map-shim that normalizes `PropSpec`s to
 * `Prop` instances before calling `.toJSON()`.
 *
 * Decoding (the reverse — JSON → runtime) lives here as free functions
 * because each decode needs the registry to recurse into child types,
 * and putting them as static methods on the runtime classes would mean
 * every runtime class importing the registry.
 */

// ─── encode (runtime → schema) ────────────────────────────────────────────

/**
 * Map a record of Prop/PropSpec values to their JSON form. Normalizes
 * each entry through `Prop.from` so `PropSpec` plain objects work
 * alongside `Prop` instances. The only free encode function — the
 * single-instance ones live as methods on the runtime classes.
 */
export function encodeProps(props: Record<string, Prop | PropSpec>): Record<string, PropDef> {
  const out: Record<string, PropDef> = {};
  for (const [name, prop] of Object.entries(props)) {
    out[name] = Prop.from(prop).toJSON();
  }
  return out;
}

// ─── decode (schema → runtime), recurses via registry ────────────────────

export function decodeProp(def: PropDef, scope: TypeScope): Prop {
  return new Prop({
    type: scope.parse(def.type),
    get: def.get,
    set: def.set,
    default: def.default,
    docs: def.docs,
  });
}

export function decodeProps(
  defs: Record<string, PropDef>,
  scope: TypeScope,
): Record<string, Prop> {
  const out: Record<string, Prop> = {};
  for (const [name, def] of Object.entries(defs)) out[name] = decodeProp(def, scope);
  return out;
}

export function decodeGetSet(def: GetSetDef, scope: TypeScope): GetSet {
  return new GetSet({
    key: scope.parse(def.key),
    value: scope.parse(def.value),
    get: def.get,
    set: def.set,
    loop: def.loop,
    loopDynamic: def.loopDynamic,
    docs: def.docs,
  });
}

/**
 * Decode a CallDef into a `Call`. When `def.types` is non-empty, build
 * a `LocalScope` layered on top of `scope` and bind each alias to its
 * (sequentially-parsed) Type — earlier aliases are visible to later
 * ones and to the call's args/returns/throws/get/set. The call retains
 * the alias map so `Call.toJSON()` can round-trip it.
 */
export function decodeCall(def: CallDef, scope: TypeScope): Call {
  let inner: TypeScope = scope;
  let aliases: Record<string, Type> | undefined;
  if (def.types && Object.keys(def.types).length > 0) {
    const local = new LocalScope(scope);
    inner = local;
    aliases = {};
    for (const [name, aliasDef] of Object.entries(def.types)) {
      const t = local.parse(aliasDef);
      local.bind(name, t);
      aliases[name] = t;
    }
  }

  return new Call({
    args: inner.parse(def.args) as Type<any>,
    returns: def.returns ? inner.parse(def.returns) : undefined,
    throws: def.throws ? inner.parse(def.throws) : undefined,
    get: def.get,
    set: def.set,
    docs: def.docs,
    types: aliases,
  });
}

export function decodeInit(
  def: NonNullable<TypeDef['init']>,
  scope: TypeScope,
): Init {
  return new Init({
    args: scope.parse(def.args) as Type<any>,
    run: def.run,
    docs: def.docs,
  });
}
