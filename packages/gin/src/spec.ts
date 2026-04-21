import type { Registry } from './registry';
import { Call, GetSet, Init, Prop, type PropSpec, type Type } from './type';
import type { CallDef, GetSetDef, PropDef, TypeDef } from './schema';

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
    next.call = {
      ...def.call,
      args: substituteTypeDef(def.call.args, bindings, registry),
      returns: def.call.returns ? substituteTypeDef(def.call.returns, bindings, registry) : undefined,
      throws: def.call.throws ? substituteTypeDef(def.call.throws, bindings, registry) : undefined,
    };
  }

  if (def.init) {
    next.init = { ...def.init, args: substituteTypeDef(def.init.args, bindings, registry) };
  }

  return next;
}

/**
 * Runtime ↔ schema conversion for Prop/GetSet/Call/Init specs.
 * Runtime specs hold resolved Type instances; schema specs hold TypeDef JSON.
 * Each concrete Type uses these when implementing encode() and parse/from.
 */

// ─── encode (runtime → schema) ────────────────────────────────────────────

export function encodeProp(prop: Prop | PropSpec): PropDef {
  return {
    docs: prop.docs,
    type: prop.type.toJSON(),
    get: prop.get,
    default: prop.default,
    set: prop.set,
  };
}

export function encodeProps(props: Record<string, Prop | PropSpec>): Record<string, PropDef> {
  const out: Record<string, PropDef> = {};
  for (const [name, prop] of Object.entries(props)) out[name] = encodeProp(prop);
  return out;
}

export function encodeGetSet(gs: GetSet): GetSetDef {
  return {
    docs: gs.docs,
    key: gs.key.toJSON(),
    value: gs.value.toJSON(),
    get: gs.get,
    set: gs.set,
    loop: gs.loop,
  };
}

export function encodeCall(call: Call): CallDef {
  return {
    docs: call.docs,
    args: call.args.toJSON(),
    returns: call.returns?.toJSON(),
    throws: call.throws?.toJSON(),
    get: call.get,
    set: call.set,
  };
}

export function encodeInit(init: Init): NonNullable<TypeDef['init']> {
  return {
    docs: init.docs,
    args: init.args.toJSON(),
    run: init.run,
  };
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
    docs: def.docs,
  });
}

export function decodeCall(def: CallDef, registry: Registry): Call {
  return new Call({
    args: registry.parse(def.args) as Type<any>,
    returns: def.returns ? registry.parse(def.returns) : undefined,
    throws: def.throws ? registry.parse(def.throws) : undefined,
    get: def.get,
    set: def.set,
    docs: def.docs,
  });
}

export function decodeInit(def: NonNullable<TypeDef['init']>, registry: Registry): Init {
  return new Init({
    args: registry.parse(def.args) as Type<any>,
    run: def.run,
    docs: def.docs,
  });
}
