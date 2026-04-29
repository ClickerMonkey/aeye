/**
 * Call-level type-alias inliner.
 *
 * `CallDef.types` declares a sequential map of locally-scoped TypeDefs
 * that resolve in `args` / `returns` / `throws` / `get` / `set` via
 * bare `{name: '<aliasName>'}` references. This module's two walkers
 * substitute those references with deep clones of the alias's source,
 * producing fully-inlined TypeDefs/ExprDefs that the existing decoders
 * (`decodeCall`, `registry.parse`) can consume without scope plumbing.
 *
 * Both walkers are pure JSON-in / JSON-out — no registry access, no
 * Type construction. Field shapes come from `schema.ts`.
 *
 * Why this rather than reusing `spec.ts:substituteChildren`? That
 * helper round-trips through `registry.parse(def).substitute().toJSON()`
 * (`spec.ts:19-25`). On a TypeDef containing an alias name not in the
 * registry, `registry.parse` throws before any rewriting can happen.
 * It also misses several slots we need (constraint, init.run, ExprDef
 * trees inside call.get/set / new.type / lambda / native / define).
 */
import type {
  CallDef,
  ExprDef,
  PathDef,
  PathStepDef,
  PathCallDef,
  PathIndexDef,
  TypeDef,
} from '../schema';
import type { Registry } from '../registry';
import { TypeError } from '../problem';

export type AliasMap = Record<string, TypeDef>;

const ALIAS_REF_DISALLOWED_PEERS: ReadonlyArray<keyof TypeDef> = [
  'extends', 'satisfies', 'generic', 'options', 'init',
  'props', 'get', 'call', 'constraint',
];

/** True if `def` is a bare alias reference: `{name}` with optional
 *  `docs` only, and `name` is in `aliases`. Any structural peer
 *  (extends/options/generic/etc.) means it's NOT a ref — let the
 *  registry/type machinery handle it normally. */
function isAliasRef(def: TypeDef, aliases: AliasMap): boolean {
  if (!aliases[def.name]) return false;
  for (const k of ALIAS_REF_DISALLOWED_PEERS) {
    if ((def as unknown as Record<string, unknown>)[k] !== undefined) return false;
  }
  return true;
}

/** Deep-clone a TypeDef. Used so each inlined site is independent —
 *  later substitution (.bind) on one site doesn't bleed into others. */
function cloneTypeDef(def: TypeDef): TypeDef {
  return JSON.parse(JSON.stringify(def)) as TypeDef;
}

/**
 * Walk a TypeDef substituting bare alias references with deep clones
 * of the alias's source. Recurses through every TypeDef-bearing slot.
 */
export function inlineTypeDef(def: TypeDef, aliases: AliasMap): TypeDef {
  if (isAliasRef(def, aliases)) {
    return cloneTypeDef(aliases[def.name]!);
  }

  const next: TypeDef = { ...def };

  // Defensive: an alias name appearing in `extends` or `satisfies` is a
  // user error — aliases can't be extended; aliases must be referenced
  // by the bare `{name}` shape.
  if (def.extends && aliases[def.extends]) {
    throw new TypeError({
      path: ['extends'],
      code: 'call.types.extends-alias',
      message: `'${def.extends}' is a call-local type alias and cannot be used as 'extends'. Use a registered named type, or write the alias's def inline.`,
      severity: 'error',
    });
  }
  if (def.satisfies) {
    for (const s of def.satisfies) {
      if (aliases[s]) {
        throw new TypeError({
          path: ['satisfies'],
          code: 'call.types.extends-alias',
          message: `'${s}' is a call-local type alias and cannot be used in 'satisfies'.`,
          severity: 'error',
        });
      }
    }
  }

  if (def.generic) {
    const g: Record<string, TypeDef> = {};
    for (const [k, v] of Object.entries(def.generic)) {
      g[k] = inlineTypeDef(v, aliases);
    }
    next.generic = g;
  }

  // `or<...>` carries its variants on `options.types`, not on the
  // standard `generic`/`props` slots. Walk them so an alias used in
  // `or` resolves correctly.
  if (def.options && Array.isArray((def.options as { types?: TypeDef[] }).types)) {
    const options = { ...(def.options as Record<string, unknown>) };
    options['types'] = ((def.options as { types: TypeDef[] }).types).map((t) => inlineTypeDef(t, aliases));
    next.options = options;
  }

  if (def.props) {
    const p: Record<string, NonNullable<TypeDef['props']>[string]> = {};
    for (const [k, pd] of Object.entries(def.props)) {
      p[k] = {
        ...pd,
        type: inlineTypeDef(pd.type, aliases),
        get: pd.get ? inlineExprDef(pd.get, aliases) : undefined,
        set: pd.set ? inlineExprDef(pd.set, aliases) : undefined,
        default: pd.default ? inlineExprDef(pd.default, aliases) : undefined,
      };
    }
    next.props = p;
  }

  if (def.get) {
    next.get = {
      ...def.get,
      key: inlineTypeDef(def.get.key, aliases),
      value: inlineTypeDef(def.get.value, aliases),
      get: def.get.get ? inlineExprDef(def.get.get, aliases) : undefined,
      set: def.get.set ? inlineExprDef(def.get.set, aliases) : undefined,
      loop: def.get.loop ? inlineExprDef(def.get.loop, aliases) : undefined,
    };
  }

  if (def.call) {
    next.call = {
      ...def.call,
      args: inlineTypeDef(def.call.args, aliases),
      returns: def.call.returns ? inlineTypeDef(def.call.returns, aliases) : undefined,
      throws: def.call.throws ? inlineTypeDef(def.call.throws, aliases) : undefined,
      get: def.call.get ? inlineExprDef(def.call.get, aliases) : undefined,
      set: def.call.set ? inlineExprDef(def.call.set, aliases) : undefined,
      // NOTE: a NESTED call's own `types` map is its own scope. Don't
      // strip it here; let the inner `decodeCall` process it. Outer
      // aliases STILL inline into inner non-types slots, which is the
      // expected behavior — outer aliases are visible inside inner
      // until the inner shadows.
    };
  }

  if (def.init) {
    next.init = {
      ...def.init,
      args: inlineTypeDef(def.init.args, aliases),
      run: inlineExprDef(def.init.run, aliases),
    };
  }

  if (def.constraint) {
    next.constraint = inlineExprDef(def.constraint, aliases);
  }

  return next;
}

/**
 * Walk an ExprDef substituting alias references inside any embedded
 * TypeDefs. Recurses into child ExprDefs.
 */
export function inlineExprDef(expr: ExprDef, aliases: AliasMap): ExprDef {
  const next: ExprDef = { ...expr };

  switch (expr.kind) {
    case 'new': {
      const e = expr as ExprDef & { type: TypeDef; value?: unknown };
      next['type'] = inlineTypeDef(e.type, aliases);
      // `value` may itself contain ExprDefs (e.g. for new list / new
      // obj — slots are Exprs). Recurse via a permissive walker.
      if (e.value !== undefined) next['value'] = inlineNewValue(e.value, aliases);
      return next;
    }
    case 'lambda': {
      const e = expr as ExprDef & { type: TypeDef; body: ExprDef; constraint?: ExprDef };
      next['type'] = inlineTypeDef(e.type, aliases);
      next['body'] = inlineExprDef(e.body, aliases);
      if (e.constraint) next['constraint'] = inlineExprDef(e.constraint, aliases);
      return next;
    }
    case 'native': {
      const e = expr as ExprDef & { type?: TypeDef };
      if (e.type) next['type'] = inlineTypeDef(e.type, aliases);
      return next;
    }
    case 'define': {
      const e = expr as ExprDef & { vars: Array<{ name: string; type?: TypeDef; value: ExprDef }>; body: ExprDef };
      next['vars'] = e.vars.map((v) => ({
        name: v.name,
        type: v.type ? inlineTypeDef(v.type, aliases) : undefined,
        value: inlineExprDef(v.value, aliases),
      }));
      next['body'] = inlineExprDef(e.body, aliases);
      return next;
    }
    case 'block': {
      const e = expr as ExprDef & { lines: ExprDef[] };
      next['lines'] = e.lines.map((l) => inlineExprDef(l, aliases));
      return next;
    }
    case 'if': {
      const e = expr as ExprDef & { ifs: Array<{ condition: ExprDef; body: ExprDef }>; else?: ExprDef };
      next['ifs'] = e.ifs.map((b) => ({
        condition: inlineExprDef(b.condition, aliases),
        body: inlineExprDef(b.body, aliases),
      }));
      if (e.else) next['else'] = inlineExprDef(e.else, aliases);
      return next;
    }
    case 'switch': {
      const e = expr as ExprDef & { value: ExprDef; cases: Array<{ equals: ExprDef[]; body: ExprDef }>; else?: ExprDef };
      next['value'] = inlineExprDef(e.value, aliases);
      next['cases'] = e.cases.map((c) => ({
        equals: c.equals.map((eq) => inlineExprDef(eq, aliases)),
        body: inlineExprDef(c.body, aliases),
      }));
      if (e.else) next['else'] = inlineExprDef(e.else, aliases);
      return next;
    }
    case 'loop': {
      const e = expr as ExprDef & { over: ExprDef; body: ExprDef; parallel?: { concurrent?: ExprDef; rate?: ExprDef } };
      next['over'] = inlineExprDef(e.over, aliases);
      next['body'] = inlineExprDef(e.body, aliases);
      if (e.parallel) {
        next['parallel'] = {
          concurrent: e.parallel.concurrent ? inlineExprDef(e.parallel.concurrent, aliases) : undefined,
          rate: e.parallel.rate ? inlineExprDef(e.parallel.rate, aliases) : undefined,
        };
      }
      return next;
    }
    case 'template': {
      const e = expr as ExprDef & { template: unknown; params: ExprDef };
      // template can be a string OR an ExprDef. Inline only when it's
      // an Expr-shaped object.
      if (e.template && typeof e.template === 'object' && 'kind' in (e.template as object)) {
        next['template'] = inlineExprDef(e.template as ExprDef, aliases);
      }
      next['params'] = inlineExprDef(e.params, aliases);
      return next;
    }
    case 'flow': {
      const e = expr as ExprDef & { value?: ExprDef; error?: ExprDef };
      if (e.value) next['value'] = inlineExprDef(e.value, aliases);
      if (e.error) next['error'] = inlineExprDef(e.error, aliases);
      return next;
    }
    case 'set': {
      const e = expr as ExprDef & { path: PathDef; value: ExprDef };
      next['path'] = inlinePath(e.path, aliases);
      next['value'] = inlineExprDef(e.value, aliases);
      return next;
    }
    case 'get': {
      const e = expr as ExprDef & { path: PathDef };
      next['path'] = inlinePath(e.path, aliases);
      return next;
    }
    default:
      // Unknown kind — leave as-is. New expr kinds added later should
      // teach this walker about their TypeDef-bearing slots.
      return next;
  }
}

/** PathDef step list — `args` map of ExprDefs, `generic` map of TypeDefs,
 *  `key` ExprDef, `catch` ExprDef. Walks all of them. */
function inlinePath(path: PathDef, aliases: AliasMap): PathDef {
  return path.map((step) => inlinePathStep(step, aliases));
}

function inlinePathStep(step: PathStepDef, aliases: AliasMap): PathStepDef {
  if ('prop' in step) return step;
  if ('args' in step) {
    const c = step as PathCallDef;
    const out: PathCallDef = {
      args: Object.fromEntries(
        Object.entries(c.args).map(([k, v]) => [k, inlineExprDef(v, aliases)]),
      ),
    };
    if (c.generic) {
      out.generic = Object.fromEntries(
        Object.entries(c.generic).map(([k, v]) => [k, inlineTypeDef(v, aliases)]),
      );
    }
    if (c.catch) out.catch = inlineExprDef(c.catch, aliases);
    return out;
  }
  // index step
  const i = step as PathIndexDef;
  return { key: inlineExprDef(i.key, aliases) };
}

/**
 * `new.value` is a permissive shape — it depends on the type's
 * `toNewSchema`. Composites accept Expr slots; primitives accept raw
 * values. We only need to recurse where the value LOOKS like an
 * ExprDef (object with `kind`) or where it's a structure containing
 * ExprDefs (arrays for list-new, records for obj-new).
 */
function inlineNewValue(value: unknown, aliases: AliasMap): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => inlineNewValue(v, aliases));
  }
  if ('kind' in (value as object) && typeof (value as { kind: unknown }).kind === 'string') {
    return inlineExprDef(value as ExprDef, aliases);
  }
  // Plain record (e.g. obj-new value) — recurse into its values.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = inlineNewValue(v, aliases);
  }
  return out;
}

/**
 * Validate alias names BEFORE inlining begins. Throws `TypeError` with
 * a namespaced code on the first offence — matches `decodeCall`'s
 * existing throw-on-structural-error convention.
 */
export function validateAliasNames(names: ReadonlyArray<string>, registry: Registry): void {
  const classNames = new Set(registry.typeClasses().map((c) => c.NAME));
  for (const name of names) {
    if (name === '') {
      throw new TypeError({
        path: ['types'],
        code: 'call.types.empty-name',
        message: 'call.types alias name cannot be empty',
        severity: 'error',
      });
    }
    if (classNames.has(name)) {
      throw new TypeError({
        path: ['types', name],
        code: 'call.types.name-conflict',
        message: `call.types alias '${name}' shadows a built-in type class — pick a different name`,
        severity: 'error',
      });
    }
  }
}

/**
 * Build the alias source map for a CallDef. Each alias's value is
 * `inlineTypeDef(def, prevAliases)` so later aliases see earlier ones.
 * Returns an empty map if `types` is undefined or empty.
 *
 * Forward / self references are caught implicitly: if alias B
 * references alias A and A hasn't been declared yet, the bare-ref
 * lookup misses (returns undefined) and the bare ref survives into
 * the parsed output, where `registry.parse` then throws "unknown
 * type" — but that error is opaque. We surface a clearer one by
 * checking after the inline pass.
 */
export function buildAliasMap(types: Record<string, TypeDef> | undefined, registry: Registry): AliasMap {
  if (!types) return {};
  const names = Object.keys(types);
  validateAliasNames(names, registry);
  const allNames = new Set(names);

  const aliases: AliasMap = {};
  for (const name of names) {
    const inlined = inlineTypeDef(types[name]!, aliases);
    // After inlining-against-prior, any surviving bare reference to a
    // name that's ALSO in the full alias name set is a forward (or
    // self) reference — that ref couldn't be resolved because its
    // target hadn't been declared yet. Refs to names outside the
    // alias set fall through to the registry at parse time, which
    // throws its own "unknown type" — leave those alone here.
    const offending = findBareRefToAny(inlined, allNames);
    if (offending) {
      throw new TypeError({
        path: ['types', name],
        code: 'call.types.forward-ref',
        message: `call.types alias '${name}' references '${offending}' before it's declared (or itself) — declare prerequisites earlier in the types map`,
        severity: 'error',
      });
    }
    aliases[name] = inlined;
  }
  return aliases;
}

/** Walk `def` and return the first bare-ref name (if any) that
 *  appears in `names`. Used by `buildAliasMap` to detect forward /
 *  self references after each alias has been inlined-against-prior:
 *  a surviving bare ref to a name ALSO declared in the alias set is
 *  necessarily one that wasn't yet declared at inline time. */
function findBareRefToAny(def: TypeDef, names: ReadonlySet<string>): string | undefined {
  if (names.has(def.name)) {
    let bare = true;
    for (const k of ALIAS_REF_DISALLOWED_PEERS) {
      if ((def as unknown as Record<string, unknown>)[k] !== undefined) { bare = false; break; }
    }
    if (bare) return def.name;
  }
  if (def.generic) {
    for (const v of Object.values(def.generic)) {
      const f = findBareRefToAny(v, names); if (f) return f;
    }
  }
  if (def.props) {
    for (const pd of Object.values(def.props)) {
      const f = findBareRefToAny(pd.type, names); if (f) return f;
    }
  }
  if (def.call) {
    let f = findBareRefToAny(def.call.args, names); if (f) return f;
    if (def.call.returns) { f = findBareRefToAny(def.call.returns, names); if (f) return f; }
    if (def.call.throws)  { f = findBareRefToAny(def.call.throws,  names); if (f) return f; }
  }
  if (def.init) {
    const f = findBareRefToAny(def.init.args, names); if (f) return f;
  }
  if (def.get) {
    let f = findBareRefToAny(def.get.key, names); if (f) return f;
    f = findBareRefToAny(def.get.value, names); if (f) return f;
  }
  if (def.options && Array.isArray((def.options as { types?: TypeDef[] }).types)) {
    for (const t of (def.options as { types: TypeDef[] }).types) {
      const f = findBareRefToAny(t, names); if (f) return f;
    }
  }
  return undefined;
}

/** Inline an entire CallDef's slots against the supplied alias map.
 *  Returns a new CallDef WITHOUT the `types` field (inlined output is
 *  alias-free). Source CallDef is not mutated. */
export function inlineCallDef(def: CallDef, aliases: AliasMap): CallDef {
  return {
    docs: def.docs,
    args: inlineTypeDef(def.args, aliases),
    returns: def.returns ? inlineTypeDef(def.returns, aliases) : undefined,
    throws: def.throws ? inlineTypeDef(def.throws, aliases) : undefined,
    get: def.get ? inlineExprDef(def.get, aliases) : undefined,
    set: def.set ? inlineExprDef(def.set, aliases) : undefined,
  };
}
