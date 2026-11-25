/**
 * Schema DEPTH for the query grammar: the per-axis tightness vocabulary, the
 * presets / `strict` sugar, and the `maxEnumSize` degrade ladders — resolved
 * to one concrete `ResolvedSchemaDepth` that the grammar (`grammar.ts`) builds
 * from and the tool's instructions describe (`depthInstructions`), so the two
 * never disagree.
 *
 * GRADUATED DEPTH: every constrainable axis is dialed INDEPENDENTLY via
 * `depth` —
 *  - `refs`      — `field-ref` / join `on` (`open` → `paired`);
 *  - `typeNames` — bare Type-name positions (`open` → `enum`);
 *  - `functions` — the four function-call kinds and operators (`open` → `names` → `typed`);
 *  - `filters`   — the `filters` clause (`open` → `paired`);
 *  - `writes`    — INSERT rows / UPDATE SET (`open` → `names` → `typed`).
 * `maxEnumSize` AUTO-DEGRADES any axis whose enumeration would exceed it.
 */
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { Type } from '../type';
import { selectFunctions, type FunctionSelector } from '../schema-build';
import type { ResolvedSchemaDepth, RefDepth, NameDepth, FnDepth, FilterDepth, WriteDepth, SelectedFunctions } from '../node';

/** The default Type-count past which the structured schema is abandoned. */
export const DEFAULT_MAX_QUERY_SCHEMA_TYPES = 5;

// ─── Depth vocabulary ────────────────────────────────────────────────────────
//
// The per-axis level unions (`RefDepth` / `NameDepth` / `FnDepth`) now live in
// `node.ts` (the shared, `llm`-free module) so `ResolvedSchemaDepth` references
// them directly. Re-exported here so existing `llm/schemas` imports keep working.
export type { RefDepth, NameDepth, FnDepth, FilterDepth, WriteDepth, ResolvedSchemaDepth } from '../node';

// The function selection TYPE lives in `node.ts` (so `SchemaOptions` can carry
// it); the resolving FUNCTION + the `FunctionSelector` authoring union live in
// `schema-build.ts`. Both are re-exported here as part of this module's surface.
export type { SelectedFunctions } from '../node';
export { selectFunctions, type FunctionSelector } from '../schema-build';

/** A partial, per-axis depth specification; unset axes fall back to the preset. */
export interface SchemaDepth {
  /** `field-ref` / join `on` reference tightness. */
  refs?: RefDepth;
  /** Bare Type-name positions. */
  typeNames?: NameDepth;
  /** The four function-call kinds. */
  functions?: FnDepth;
  /** The `filters` clause. */
  filters?: FilterDepth;
  /** INSERT-row / UPDATE-SET write shapes. */
  writes?: WriteDepth;
}

/** Options accepted by `buildSchemas`. */
export interface BuildSchemasOptions {
  /**
   * Per-axis schema tightness. A `SchemaDepth` object dials each axis
   * independently; the string presets `'open'` (all loose) / `'paired'` (all
   * tight) expand to every axis. Unspecified axes of a partial `SchemaDepth`
   * inherit the resolved preset (or the `strict` sugar, else `'open'`).
   */
  depth?: SchemaDepth | 'open' | 'paired';
  /**
   * Which functions populate the `names` / `typed` function schemas.
   * Defaults to `'all'`.
   */
  functions?: FunctionSelector;
  /**
   * When set, AUTO-DEGRADE any axis whose enumeration would exceed this many
   * entries one level looser (see `degradeRefs` / `degradeFns`). Counts used:
   * #Types for the source/type-name axis, #distinct fields for the field axis,
   * #selected functions (largest shape group) for the function axis. No-op when
   * unset.
   */
  maxEnumSize?: number;
  /**
   * DEPRECATED binary sugar. `strict: true` ⇒ `depth: 'paired'`;
   * `strict: false` / absent ⇒ `depth: 'open'`. Prefer `depth`.
   */
  strict?: boolean;
  /** Attach `.describe(...)` docs to generated schemas for LLM prompting. */
  includeDocs?: 'none' | 'type' | 'all';
  /**
   * Restrict the enumerated Types (depth + instance branches) to this subset.
   * Defaults to every Type registered on the registry.
   */
  types?: Type[];
}

/** Narrow a `QueryEngine | Registry` to its `Registry` without a cast. */
export function toRegistry(engineOrRegistry: QueryEngine | Registry): Registry {
  return 'registry' in engineOrRegistry ? engineOrRegistry.registry : engineOrRegistry;
}

/** The distinct field NAMES across a set of Types (deduped, stable order). */
function uniqueFieldNames(types: readonly Type[]): string[] {
  const seen = new Set<string>();
  for (const t of types) for (const f of t.fields) seen.add(f.name);
  return Array.from(seen);
}

/** The size of the largest selected per-shape group (the function-axis budget). */
function maxFunctionGroup(s: SelectedFunctions): number {
  return Math.max(s.scalar.length, s.tabular.length, s.window.length, s.aggregate.length);
}

// ─── Depth resolution + degradation ──────────────────────────────────────────

/** Expand a preset into a fully-concretized per-axis depth. */
function expandPreset(preset: 'open' | 'paired'): ResolvedSchemaDepth {
  return preset === 'paired'
    ? { refs: 'paired', typeNames: 'enum', functions: 'typed', filters: 'paired', writes: 'typed' }
    : { refs: 'open', typeNames: 'open', functions: 'open', filters: 'open', writes: 'open' };
}

/** The base preset a (partial) `depth` / `strict` resolves against. */
function presetBase(options: BuildSchemasOptions): 'open' | 'paired' {
  if (options.depth === 'paired') return 'paired';
  if (options.depth === 'open') return 'open';
  // A partial `SchemaDepth` object (or no `depth`) inherits the `strict` sugar.
  if (options.strict === true) return 'paired';
  return 'open';
}

/**
 * AUTO-DEGRADE the `refs` axis so no enumeration exceeds `max`, loosest step
 * first. Ladder (tightest → loosest):
 *   `paired` → `both` → (`types` | `fields` | `open`)
 * `paired` is a per-Type union enumerating each Type's fields, so it needs BOTH
 * the Type count AND the field count to fit; over budget it drops to `both`.
 * `both` enumerates Type names and field names independently — whichever axis is
 * over budget loses its enum: both over ⇒ `open`, only Types over ⇒ `fields`
 * (keep the field enum), only fields over ⇒ `types` (keep the Type enum).
 * `types` / `fields` drop to `open` when their single enum is over budget.
 */
function degradeRefs(d: RefDepth, typeCount: number, fieldCount: number, max: number): RefDepth {
  const typesOver = typeCount > max;
  const fieldsOver = fieldCount > max;
  let depth = d;
  if (depth === 'paired' && (typesOver || fieldsOver)) depth = 'both';
  if (depth === 'both') {
    if (typesOver && fieldsOver) return 'open';
    if (typesOver) return 'fields';
    if (fieldsOver) return 'types';
    return 'both';
  }
  if (depth === 'types' && typesOver) return 'open';
  if (depth === 'fields' && fieldsOver) return 'open';
  return depth;
}

/**
 * AUTO-DEGRADE the `functions` axis. Ladder (tightest → loosest):
 *   `typed` → `names` → `open`
 * `typed` builds one union branch per selected function (the most expensive), so
 * it drops to `names` (a single name enum) when the largest shape group exceeds
 * the budget; the name enum itself drops to `open` when still over budget.
 */
function degradeFns(d: FnDepth, fnCount: number, max: number): FnDepth {
  let depth = d;
  if (depth === 'typed' && fnCount > max) depth = 'names';
  if (depth === 'names' && fnCount > max) depth = 'open';
  return depth;
}

/**
 * AUTO-DEGRADE the `writes` axis (mirrors `degradeFns`). Ladder (tightest →
 * loosest): `typed` → `names` → `open`. The per-Type write objects enumerate a
 * Type's writable field NAMES, so the field count governs the budget: over it
 * the shape drops one level looser (`typed` → `names`, then `names` → the free
 * `z.record(string, Expr)`).
 */
function degradeWrites(d: WriteDepth, fieldCount: number, max: number): WriteDepth {
  let depth = d;
  if (depth === 'typed' && fieldCount > max) depth = 'names';
  if (depth === 'names' && fieldCount > max) depth = 'open';
  return depth;
}

/** Catalog counts the degrade ladders consult. */
interface DepthCounts {
  typeCount: number;
  fieldCount: number;
  fnCount: number;
}

/**
 * Resolve the caller's `depth` / `strict` / `maxEnumSize` options into a single
 * concrete per-axis `ResolvedSchemaDepth`: expand the preset, overlay any
 * partial `SchemaDepth`, then apply `maxEnumSize` degradation.
 */
function resolveDepth(options: BuildSchemasOptions, counts: DepthCounts): ResolvedSchemaDepth {
  const base = expandPreset(presetBase(options));
  const d: ResolvedSchemaDepth =
    typeof options.depth === 'object'
      ? {
          refs: options.depth.refs ?? base.refs,
          typeNames: options.depth.typeNames ?? base.typeNames,
          functions: options.depth.functions ?? base.functions,
          filters: options.depth.filters ?? base.filters,
          writes: options.depth.writes ?? base.writes,
        }
      : base;

  if (options.maxEnumSize === undefined) return d;
  const max = options.maxEnumSize;
  return {
    refs: degradeRefs(d.refs, counts.typeCount, counts.fieldCount, max),
    typeNames: d.typeNames === 'enum' && counts.typeCount > max ? 'open' : d.typeNames,
    functions: degradeFns(d.functions, counts.fnCount, max),
    // The `paired` filters clause enumerates `(field, op)` pairs per Type, so it
    // is governed by the field count; over budget it drops to the loose clause.
    filters: d.filters === 'paired' && counts.fieldCount > max ? 'open' : d.filters,
    // The `names` / `typed` write objects enumerate writable field names, so the
    // field count governs the budget (mirrors `filters`).
    writes: degradeWrites(d.writes, counts.fieldCount, max),
  };
}

/**
 * Whether the structured query schema should be ABANDONED for a plain
 * natural-language string, because there are too many Types to enumerate
 * usefully (mirrors cletus's `shouldUseStringSchema`).
 */
export function shouldUseStringSchema(
  types: readonly Type[],
  max: number = DEFAULT_MAX_QUERY_SCHEMA_TYPES,
): boolean {
  return types.length > max;
}

/** Options for `querySchema`. */
export interface QuerySchemaOptions extends BuildSchemasOptions {
  /** Type-count threshold for the string fallback. Default 5. */
  max?: number;
}

/**
 * Resolve the caller's `buildSchemas` options into the SAME concrete per-axis
 * `ResolvedSchemaDepth` the generated schema uses (presets + `strict` sugar +
 * `maxEnumSize` degradation). Exposed so prompt-builders (`buildQueryTool`) can
 * describe the active depth and stay in lock-step with the schema.
 */
export function resolveSchemaDepth(
  engine: QueryEngine | Registry,
  options: BuildSchemasOptions = {},
): ResolvedSchemaDepth {
  const registry = toRegistry(engine);
  const types = options.types ?? registry.typeList();
  const selected = selectFunctions(registry, options.functions);
  return resolveDepth(options, {
    typeCount: types.length,
    fieldCount: uniqueFieldNames(types).length,
    fnCount: maxFunctionGroup(selected),
  });
}

/**
 * A short, LLM-facing note describing which query positions the ACTIVE schema
 * depth constrains, so the prompt and the schema agree. Returns `''` when every
 * axis is `open` (free-string mode — nothing to flag). Resolution mirrors
 * `buildSchemas` exactly (including `maxEnumSize` auto-degrade), so the note is
 * never tighter than the schema actually is.
 */
export function depthInstructions(
  engine: QueryEngine | Registry,
  options: BuildSchemasOptions = {},
): string {
  const depth = resolveSchemaDepth(engine, options);
  const notes: string[] = [];

  switch (depth.refs) {
    case 'paired':
      notes.push(
        'Field references are CONSTRAINED: `source` must be a known Type name and `field` must be one of THAT Type’s fields (a `field-ref` cannot mix one Type’s source with another Type’s field).',
      );
      break;
    case 'both':
      notes.push('Field references use known Type names for `source` and known field names for `field`.');
      break;
    case 'types':
      notes.push('A field reference’s `source` must be a known Type name.');
      break;
    case 'fields':
      notes.push('A field reference’s `field` must be a known field name.');
      break;
    case 'open':
      break;
  }

  if (depth.typeNames === 'enum') {
    notes.push('Type-name positions (FROM / INTO / UPDATE / DELETE) must be one of the registered Type names.');
  }

  switch (depth.functions) {
    case 'typed':
      notes.push(
        'Function / aggregate / window calls are limited to the functions listed above; each call’s `args` must be that function’s declared NAMED parameters (no unknown argument names).',
      );
      break;
    case 'names':
      notes.push('Function names (in function-call / aggregate / window / tabular calls) must be one of the functions listed above.');
      break;
    case 'open':
      break;
  }

  if (depth.filters === 'paired') {
    notes.push('A `filters` placeholder’s `source` must be a known Type name and its optional `fields` allowlist must name that Type’s fields.');
  }

  switch (depth.writes) {
    case 'typed':
      notes.push(
        'INSERT rows / UPDATE assignments are keyed field→value objects restricted to the target Type’s writable fields; each value is that field’s typed value OR an expression, and every required-on-insert field must be present. Omit a field (or use JSON null) to leave it unset; to set SQL NULL use a literal-null expression `{ kind:"literal", value:null }`.',
      );
      break;
    case 'names':
      notes.push(
        'INSERT rows / UPDATE assignments are keyed field→value objects restricted to the target Type’s writable field names (values are expressions). Omit a field (or use JSON null) to leave it unset; to set SQL NULL use a literal-null expression.',
      );
      break;
    case 'open':
      break;
  }

  return notes.join('\n');
}/** The resolved depth for these Types and selected functions (what `buildSchemas` builds at). */
export function resolveDepthFor(types: readonly Type[], selected: SelectedFunctions, options: BuildSchemasOptions = {}): ResolvedSchemaDepth {
  return resolveDepth(options, {
    typeCount: types.length,
    fieldCount: uniqueFieldNames(types).length,
    fnCount: maxFunctionGroup(selected),
  });
}


