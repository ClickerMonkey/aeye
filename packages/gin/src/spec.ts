import type { Registry } from './registry';
import { Call, GetSet, Init, Prop, type PropSpec, type Type } from './type';
import type { CallDef, GetSetDef, PropDef, TypeDef } from './schema';
import { buildAliasMap, inlineCallDef } from './exprs/inline-aliases';

// ─── generic substitution (TypeDef tree) ─────────────────────────────────

/**
 * Walk a TypeDef substituting generic placeholders per `bindings`. Fully
 * polymorphic: parses each node into a Type and dispatches to its
 * `.substitute(bindings)` method, then re-encodes. GenericType overrides
 * substitute() to return its binding; every other type uses the default,
 * which recurses into its common child fields (generic / props / get /
 * call / init). No `name === 'generic'` check lives in this file.
 *
 * This helper is now a thin wrapper over Type.substitute — kept for
 * backwards-compat and for the registry's parse-time use (e.g., Type.bind
 * and programmatic substitution).
 */
export function substituteTypeDef(
  def: TypeDef,
  bindings: Record<string, Type>,
  registry: Registry,
): TypeDef {
  return registry.parse(def).substitute(bindings).toJSON();
}

/**
 * Default child-walker used by Type.substitute: recursively substitutes
 * the common child-type fields without knowing anything about the outer
 * type's kind. Only invoked from Type.substitute — never from user code.
 */
export function substituteChildren(
  def: TypeDef,
  bindings: Record<string, Type>,
  registry: Registry,
): TypeDef {
  const next: TypeDef = { ...def };

  if (def.generic) {
    const g: Record<string, TypeDef> = {};
    for (const [k, v] of Object.entries(def.generic)) {
      g[k] = substituteTypeDef(v, bindings, registry);
    }
    next.generic = g;
  }

  if (def.props) {
    const p: Record<string, PropDef> = {};
    for (const [k, pd] of Object.entries(def.props)) {
      p[k] = { ...pd, type: substituteTypeDef(pd.type, bindings, registry) };
    }
    next.props = p;
  }

  if (def.get) {
    next.get = {
      ...def.get,
      key: substituteTypeDef(def.get.key, bindings, registry),
      value: substituteTypeDef(def.get.value, bindings, registry),
    };
  }

  if (def.call) {
    // If the source CallDef declared `types` (call-local aliases),
    // first inline them so substituteTypeDef doesn't try to
    // registry.parse a bare alias-name and throw. Then drop `types`
    // from the substituted output — bound calls are alias-free in
    // both their parsed and JSON forms (Plan-agent footgun fix).
    const callBase = def.call.types
      ? inlineCallDef(def.call, buildAliasMap(def.call.types, registry))
      : def.call;
    next.call = {
      ...callBase,
      args: substituteTypeDef(callBase.args, bindings, registry),
      returns: callBase.returns ? substituteTypeDef(callBase.returns, bindings, registry) : undefined,
      throws: callBase.throws ? substituteTypeDef(callBase.throws, bindings, registry) : undefined,
    };
    // `types` was either absent or already consumed by the inline
    // pass — either way, the substituted output should not carry it.
    delete (next.call as { types?: unknown }).types;
  }

  if (def.init) {
    next.init = { ...def.init, args: substituteTypeDef(def.init.args, bindings, registry) };
  }

  return next;
}

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

export function decodeProp(def: PropDef, registry: Registry): Prop {
  return new Prop({
    type: registry.parse(def.type),
    get: def.get,
    set: def.set,
    default: def.default,
    docs: def.docs,
  });
}

export function decodeProps(defs: Record<string, PropDef>, registry: Registry): Record<string, Prop> {
  const out: Record<string, Prop> = {};
  for (const [name, def] of Object.entries(defs)) out[name] = decodeProp(def, registry);
  return out;
}

export function decodeGetSet(def: GetSetDef, registry: Registry): GetSet {
  return new GetSet({
    key: registry.parse(def.key),
    value: registry.parse(def.value),
    get: def.get,
    set: def.set,
    loop: def.loop,
    loopDynamic: def.loopDynamic,
    docs: def.docs,
  });
}

export function decodeCall(def: CallDef, registry: Registry): Call {
  // Build the alias source map (sequential — later may reference
  // earlier). When `def.types` is undefined this is a no-op map and
  // the inliner pass-through returns the slots unchanged.
  const aliases = buildAliasMap(def.types, registry);
  const hasAliases = Object.keys(aliases).length > 0;
  const inlined = hasAliases ? inlineCallDef(def, aliases) : def;

  return new Call({
    args: registry.parse(inlined.args) as Type<any>,
    returns: inlined.returns ? registry.parse(inlined.returns) : undefined,
    throws: inlined.throws ? registry.parse(inlined.throws) : undefined,
    get: inlined.get,
    set: inlined.set,
    docs: def.docs,
    // Source-form preservation, only when aliases were actually used.
    types: hasAliases ? aliases : undefined,
    sourceArgs: hasAliases ? def.args : undefined,
    sourceReturns: hasAliases ? def.returns : undefined,
    sourceThrows: hasAliases ? def.throws : undefined,
    sourceGet: hasAliases ? def.get : undefined,
    sourceSet: hasAliases ? def.set : undefined,
  });
}

export function decodeInit(def: NonNullable<TypeDef['init']>, registry: Registry): Init {
  return new Init({
    args: registry.parse(def.args) as Type<any>,
    run: def.run,
    docs: def.docs,
  });
}
