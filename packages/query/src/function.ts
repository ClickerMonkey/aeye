/**
 * QueryFunction — the runtime wrapper around a `FunctionDef` JSON shape.
 *
 * NAMING: the plan calls this `FunctionDef`, but `schema.ts` already exports
 * an interface named `FunctionDef` (the JSON shape) which the public barrel
 * re-exports via `export * from './schema'`. To avoid an export collision the
 * runtime class is named `QueryFunction`; it wraps a `FunctionDef`.
 *
 * Responsibilities this phase:
 *  - `resolveOutput(argTypes)` — produce the call's `ResolvedType`, honoring a
 *    static field type, a Type reference (tabular), or `'inferred'`.
 *  - `validateCall(argTypes, p)` — arity + per-parameter type-compatibility.
 *
 * A `QueryFunction` is built from JSON once (parsing each declared param /
 * output FieldType through the registry); the engine caches the instances.
 */
import type {
  FieldTypeDef,
  FunctionDef,
  FunctionParamDef,
  FunctionShape,
} from './schema';
import type { Registry } from './registry';
import type { FieldType } from './field-type';
import type { Type } from './type';
import type { Problems } from './problem';
import type {
  ResolvedType,
  FieldResolved,
  ComputedResolved,
  TypeResolved,
} from './resolved-type';
import { asFieldType, sourcesOf } from './resolved-type';

/** A parsed declared parameter: a concrete FieldType, or the `'any'` marker. */
interface ResolvedParam {
  name: string;
  /** `undefined` ⇒ the param accepts any field type (`type: 'any'`). */
  fieldType: FieldType | undefined;
  optional: boolean;
}

/**
 * A parsed output declaration:
 *  - `{ tag: 'field', fieldType }`  — a concrete scalar field type.
 *  - `{ tag: 'type', type }`       — a Type reference (tabular functions).
 *  - `{ tag: 'inferred' }`          — computed from the args at resolve time.
 */
type ResolvedOutput =
  | { tag: 'field'; fieldType: FieldType }
  | { tag: 'type'; type: Type }
  | { tag: 'inferred' };

/** A `FieldTypeDef`-shaped output declaration (vs `{type}` / `'inferred'`). */
function isFieldTypeDef(o: FunctionDef['output']): o is FieldTypeDef {
  return typeof o === 'object' && o !== null && 'kind' in o;
}

/** A `{ type: string }`-shaped output declaration (Type reference). */
function isTypeRef(o: FunctionDef['output']): o is { type: string } {
  return typeof o === 'object' && o !== null && 'type' in o;
}

/** A parsed callable (scalar / aggregate / window / tabular): name, params, and declared output. */
export class QueryFunction {
  /** The function's name (its registry key and call name). */
  readonly name: string;
  /** The call shape: `'scalar'`, `'aggregate'`, `'window'`, or `'tabular'`. */
  readonly shape: FunctionShape;
  /** The declared parameters, each a concrete FieldType or the `'any'` marker. */
  readonly params: ResolvedParam[];
  /** The output declaration: a static field type, a Type reference, or `'inferred'`. */
  readonly output: ResolvedOutput;
  /** Optional SQL template / function name (consumed by Phase 5). */
  readonly sql?: string;
  /**
   * Declared-parameter indices whose argument is emitted as an INLINE SQL
   * literal (an `EXTRACT`/`date_part` field token) instead of a bound
   * parameter. See {@link FunctionDef.rawArgs}.
   */
  readonly rawArgs?: readonly number[];
  /**
   * Terse, LLM-facing usage note (what it does / arg meaning / any gotcha).
   * See {@link FunctionDef.instructions}. Read from the def by `from`, written
   * back by `toJSON`, and exposed here as the public accessor.
   */
  readonly instructions?: string;

  /** Construct from already-parsed parts; use `from` to build from JSON. */
  constructor(spec: {
    name: string;
    shape: FunctionShape;
    params: ResolvedParam[];
    output: ResolvedOutput;
    sql?: string;
    rawArgs?: readonly number[];
    instructions?: string;
  }) {
    this.name = spec.name;
    this.shape = spec.shape;
    this.params = spec.params;
    this.output = spec.output;
    this.sql = spec.sql;
    this.rawArgs = spec.rawArgs;
    this.instructions = spec.instructions;
  }

  /** Build a runtime function from its JSON, parsing field/Type references. */
  static from(json: FunctionDef, registry: Registry): QueryFunction {
    const params: ResolvedParam[] = json.params.map((p: FunctionParamDef) => ({
      name: p.name,
      fieldType: p.type === 'any' ? undefined : registry.parseFieldType(p.type),
      optional: p.optional ?? false,
    }));

    let output: ResolvedOutput;
    if (json.output === 'inferred') {
      output = { tag: 'inferred' };
    } else if (isFieldTypeDef(json.output)) {
      output = { tag: 'field', fieldType: registry.parseFieldType(json.output) };
    } else {
      // The `output` union is total, so the remaining shape is a `{ type }` ref.
      /* v8 ignore next -- defensive: unreachable when `output` is a total union */
      if (!isTypeRef(json.output)) return assertNever(json.output);
      const type = registry.type(json.output.type);
      if (!type) {
        throw new Error(
          `QueryFunction.from: function '${json.name}' output references unknown Type '${json.output.type}'`,
        );
      }
      output = { tag: 'type', type };
    }

    return new QueryFunction({
      name: json.name,
      shape: json.shape,
      params,
      output,
      sql: json.sql,
      rawArgs: json.rawArgs,
      instructions: json.instructions,
    });
  }

  /**
   * Serialize back to the JSON `FunctionDef` shape (inverse of `from`):
   * re-emits each param / the output declaration and carries the optional
   * `sql` / `rawArgs` / `instructions` through unchanged.
   */
  toJSON(): FunctionDef {
    const params: FunctionParamDef[] = this.params.map((p) => ({
      name: p.name,
      type: p.fieldType ? p.fieldType.toJSON() : 'any',
      ...(p.optional ? { optional: true } : {}),
    }));
    let output: FunctionDef['output'];
    if (this.output.tag === 'field') output = this.output.fieldType.toJSON();
    else if (this.output.tag === 'type') output = { type: this.output.type.name };
    else output = 'inferred';
    return {
      name: this.name,
      shape: this.shape,
      params,
      output,
      ...(this.sql ? { sql: this.sql } : {}),
      ...(this.rawArgs ? { rawArgs: this.rawArgs } : {}),
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  /**
   * The argument types supplied for a call, in DECLARED parameter order
   * (skipping params with no supplied arg). Named args are matched to params
   * by name; this gives output resolution a stable order for `'inferred'`.
   */
  private orderedArgs(
    namedArgs: ReadonlyMap<string, ResolvedType>,
  ): ResolvedType[] {
    const out: ResolvedType[] = [];
    for (const param of this.params) {
      const a = namedArgs.get(param.name);
      if (a) out.push(a);
    }
    return out;
  }

  /**
   * Resolve the call's output type from its NAMED argument types.
   *  - tabular output     ⇒ a `TypeResolved` over the referenced Type.
   *  - static field type  ⇒ a `ComputedResolved` of that type.
   *  - `'inferred'`        ⇒ a `ComputedResolved` mirroring the first declared
   *                          argument's field type (falls back to the first
   *                          declared param's type, else the first arg).
   * Nullability propagates from any nullable argument; the result is an
   * aggregate when the function is aggregate-shaped or any argument is.
   */
  resolveOutput(namedArgs: ReadonlyMap<string, ResolvedType>): ResolvedType {
    if (this.output.tag === 'type') {
      const type: TypeResolved = {
        kind: 'type',
        type: this.output.type,
        source: this.name,
        synthetic: true,
      };
      return type;
    }

    const argTypes = this.orderedArgs(namedArgs);
    const sources: FieldResolved[] = [];
    let nullable = false;
    for (const a of argTypes) {
      sources.push(...sourcesOf(a));
      if (a.kind !== 'type' && a.nullable) nullable = true;
    }
    const aggregate =
      this.shape === 'aggregate' ||
      argTypes.some((a) => a.kind === 'computed' && a.aggregate);

    let fieldType: FieldType | undefined;
    if (this.output.tag === 'field') {
      fieldType = this.output.fieldType;
    } else {
      // 'inferred' — first argument with a discernible field type wins.
      for (const a of argTypes) {
        const ft = asFieldType(a);
        if (ft) {
          fieldType = ft;
          break;
        }
      }
    }

    // When inference found nothing usable, surface a nullable result whose
    // category is the first arg's (or, lacking args, left to the caller). To
    // stay type-safe we require SOME field type; reuse the first arg's, else
    // mark nullable with no sources and an unknown-but-present category by
    // borrowing the first declared param type if any.
    if (!fieldType) {
      const fallback = this.params.find((p) => p.fieldType)?.fieldType;
      if (fallback) fieldType = fallback;
    }

    if (!fieldType) {
      // No way to determine a concrete category: report as a nullable
      // computed with an empty source set is impossible without a FieldType,
      // so we conservatively fall back to the first argument's resolved type
      // unchanged when present.
      const first = argTypes[0];
      if (first) return first;
      throw new Error(
        `QueryFunction.resolveOutput: cannot infer output type for '${this.name}' (no args, no declared types).`,
      );
    }

    const computed: ComputedResolved = {
      kind: 'computed',
      fieldType,
      sources,
      nullable,
      aggregate,
    };
    return computed;
  }

  /**
   * Validate a call's NAMED arguments against the declared parameters, pushing
   * Problems at the current path. Three checks, all keyed by parameter name:
   *  - every REQUIRED param must be supplied      → `function.missing-arg`.
   *  - every supplied arg must name a real param  → `function.unknown-arg`.
   *  - each supplied arg must be type-compatible  → `function.arg-type`
   *    (a `'any'` param accepts anything), reported at path `['args', name]`.
   */
  validateCall(namedArgs: ReadonlyMap<string, ResolvedType>, p: Problems): void {
    // Required params present?
    for (const param of this.params) {
      if (param.optional) continue;
      if (!namedArgs.has(param.name)) {
        p.error(
          'function.missing-arg',
          `Function '${this.name}' is missing required argument '${param.name}'.`,
        );
      }
    }

    const byName = new Map(this.params.map((param) => [param.name, param]));
    for (const [name, argType] of namedArgs) {
      const param = byName.get(name);
      if (!param) {
        p.at(['args', name], () => {
          p.error(
            'function.unknown-arg',
            `Function '${this.name}' has no parameter named '${name}'.`,
          );
        });
        continue;
      }
      if (!param.fieldType) continue; // 'any' accepts everything
      const argFt = asFieldType(argType);
      if (!argFt) {
        p.at(['args', name], () => {
          p.error(
            'function.arg-type',
            `Argument '${name}' of '${this.name}' must be a ${param.fieldType!.resolve()} value (a type cannot be passed here).`,
          );
        });
        continue;
      }
      if (!param.fieldType.comparableWith(argFt)) {
        p.at(['args', name], () => {
          p.error(
            'function.arg-type',
            `Argument '${name}' of '${this.name}' expects ${param.fieldType!.resolve()}, got ${argFt.resolve()}.`,
          );
        });
      }
    }
  }
}

/* v8 ignore start -- compile-time exhaustiveness guard; never invoked at runtime */
/** Compile-time exhaustiveness guard. */
function assertNever(value: never): never {
  throw new Error(`QueryFunction: unhandled output variant ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
