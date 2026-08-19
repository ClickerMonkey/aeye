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
  AggregateMerge,
  ExprDef,
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
import type { Cost } from './cost';
import { ZERO_COST, NEVER_CHANGES } from './cost';
import { didYouMean } from './aids';

/**
 * ONE DECLARED, NAMED ARGUMENT — the half a FUNCTION parameter and an OPERATOR
 * operand share, and the type that DEFINES their common key set.
 *
 * Both are "a name plus the type a supplied expression is judged against", and
 * both are read by exactly the same two pieces of machinery: `observeNamedParams`
 * (which types a bare bind param FROM the declaration) and
 * {@link validateNamedCall} (which judges every other argument against it). Those
 * two took a `QueryFunction`, which is why an operator could not have reused
 * them; they take this instead, so an operand is not a second, drifting spelling
 * of the same fact.
 */
export interface DeclaredArg {
  /** The declared name — the key a call writes in its `args` object. */
  readonly name: string;
  /** The declared type, or `undefined` when it accepts any (`type: 'any'`). */
  readonly fieldType: FieldType | undefined;
  /** Whether a call may omit it. Absent ⇒ required (an operator's operands always are). */
  readonly optional?: boolean;
}

/** A parsed declared parameter: a {@link DeclaredArg} whose optionality is always resolved. */
export interface ResolvedParam extends DeclaredArg {
  readonly optional: boolean;
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

/** The default `paramArgs` of {@link QueryFunction.validateCall}: no argument is a bare bind param. */
const EMPTY_PARAM_ARGS: ReadonlySet<string> = new Set<string>();

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
  /**
   * The emitted SQL function NAME when it differs from {@link name} — NOT a
   * template. See {@link FunctionDef.sql}: per-dialect or non-`name(args)`
   * emission is a `Dialect` subclass, not a declaration.
   */
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
  /**
   * Optional WORKED examples (RAW JSON strings) that CALL this function — read
   * from the def by `from`, written back by `toJSON`, surfaced (capped) under
   * the signature by `describeEngine`. See {@link FunctionDef.examples}.
   */
  readonly examples?: readonly string[];
  /**
   * AGGREGATE un-aggregate templates — the row-level `ExprDef` this aggregate
   * summarizes, with `{kind:'arg', name}` placeholders. `unaggregate` is the
   * arg-present form, `unaggregateEmpty` the arg-less (`count(*)`) form. See
   * {@link FunctionDef.unaggregate} and `AggregateExpr.unaggregate`.
   */
  readonly unaggregate?: ExprDef;
  readonly unaggregateEmpty?: ExprDef;
  /**
   * How two of this AGGREGATE's per-group values combine into the value over the
   * union of those groups ({@link AggregateMerge}). Always answered — an
   * aggregate that declares nothing (and every non-aggregate) reports `'none'`,
   * so a consumer asking "can these two values be combined, and how" gets a total
   * answer for a caller-registered function as well as a builtin. See
   * {@link FunctionDef.merge}.
   */
  readonly merge: AggregateMerge;
  /** Intrinsic per-call cost this function adds beyond its args (default none). */
  readonly cost: Cost;
  /**
   * Milliseconds between changes to this function's RESULT independent of the
   * data (`0` = always — `now()`; `-1` = pure/never — the default; `86400000` =
   * daily — `currentDate()`). Folded into `engine.changeInterval`.
   */
  readonly changes: number;
  /** Type names this function internally READS (a UDF over a table); folded into cost / references. */
  readonly references: readonly string[];

  /** Construct from already-parsed parts; use `from` to build from JSON. */
  constructor(spec: {
    name: string;
    shape: FunctionShape;
    params: ResolvedParam[];
    output: ResolvedOutput;
    sql?: string;
    rawArgs?: readonly number[];
    instructions?: string;
    examples?: readonly string[];
    unaggregate?: ExprDef;
    unaggregateEmpty?: ExprDef;
    merge?: AggregateMerge;
    cost?: Cost;
    changes?: number;
    references?: readonly string[];
  }) {
    this.name = spec.name;
    this.shape = spec.shape;
    this.params = spec.params;
    this.output = spec.output;
    this.sql = spec.sql;
    this.rawArgs = spec.rawArgs;
    this.instructions = spec.instructions;
    this.examples = spec.examples;
    this.unaggregate = spec.unaggregate;
    this.unaggregateEmpty = spec.unaggregateEmpty;
    // Un-mergeable unless the author says otherwise — the safe default, and the
    // only honest one for a non-aggregate.
    this.merge = spec.merge ?? 'none';
    this.cost = spec.cost ?? ZERO_COST;
    this.changes = spec.changes ?? NEVER_CHANGES;
    this.references = spec.references ?? [];
  }

  /** Build a runtime function from its JSON, parsing field/Type references. */
  static from(json: FunctionDef, registry: Registry): QueryFunction {
    // A merge is a claim about combining PER-GROUP values, which only an
    // aggregate produces. Refusing it here turns a meaningless declaration into
    // an immediate registration error instead of a silently ignored key.
    if (json.merge !== undefined && json.shape !== 'aggregate') {
      throw new Error(
        `QueryFunction.from: function '${json.name}' declares merge '${json.merge}' but is '${json.shape}', not an aggregate.`,
      );
    }

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
      examples: json.examples,
      unaggregate: json.unaggregate,
      unaggregateEmpty: json.unaggregateEmpty,
      merge: json.merge,
      cost: json.cost,
      changes: json.changes,
      references: json.references,
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
      ...(this.examples ? { examples: this.examples } : {}),
      ...(this.unaggregate ? { unaggregate: this.unaggregate } : {}),
      ...(this.unaggregateEmpty ? { unaggregateEmpty: this.unaggregateEmpty } : {}),
      ...(this.merge !== 'none' ? { merge: this.merge } : {}),
      // Estimation metadata — emitted only when set away from the neutral default.
      ...(this.cost.rows !== 0 || this.cost.bytes !== 0 ? { cost: this.cost } : {}),
      ...(this.changes !== NEVER_CHANGES ? { changes: this.changes } : {}),
      ...(this.references.length > 0 ? { references: [...this.references] } : {}),
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
   *
   * `paramArgs` names the arguments that are a BARE bind param (`{kind:'param'}`),
   * which the caller has already observed against the declared parameter type
   * (`observeNamedParams`). They are exempt from the type check for the reason
   * `ComparisonExpr` exempts a param operand: a param has no type of its own —
   * this call site is where it GETS one — so there is nothing here to be wrong.
   * A param whose uses across the query have no common type is reported once, by
   * `ParamSet`, as `param.conflict`.
   */
  validateCall(
    namedArgs: ReadonlyMap<string, ResolvedType>,
    p: Problems,
    paramArgs: ReadonlySet<string> = EMPTY_PARAM_ARGS,
  ): void {
    validateNamedCall(FUNCTION_CALL_WORDS, this.name, this.params, namedArgs, p, paramArgs);
  }
}

/**
 * How one callable's call-shaped diagnostics READ. A `Record`-free bag rather
 * than three string arguments, because the four words only mean anything
 * together and a caller supplying them in the wrong order would produce a
 * grammatical message about the wrong thing.
 */
export interface CallVocabulary {
  /** The callable, capitalized as a sentence subject: `Function` / `Operator`. */
  readonly noun: string;
  /** What a CALL supplies, capitalized: `Argument` / `Operand`. */
  readonly supplied: string;
  /** What a DECLARATION declares: `parameter` / `operand`. */
  readonly declared: string;
  /** The problem-code prefix: `function` / `operator`. */
  readonly code: string;
}

/** The words a FUNCTION call's diagnostics use. */
const FUNCTION_CALL_WORDS: CallVocabulary = {
  noun: 'Function',
  supplied: 'Argument',
  declared: 'parameter',
  code: 'function',
};

/**
 * Validate a call's NAMED arguments against its DECLARED ones — the three checks
 * a function call and an operator both need, in one place:
 *  - every REQUIRED declaration must be supplied  → `<code>.missing-arg`;
 *  - every supplied arg must name a real one      → `<code>.unknown-arg`;
 *  - each supplied arg must be type-compatible    → `<code>.arg-type`
 *    (an `undefined` declared type accepts anything), at path `['args', name]`.
 *
 * `paramArgs` names the arguments that are a BARE bind param (`{kind:'param'}`),
 * which the caller has already observed against the declared type
 * (`observeNamedParams`). They are exempt from the type check for the reason
 * `ComparisonExpr` exempts a param operand: a param has no type of its own —
 * this call site is where it GETS one — so there is nothing here to be wrong. A
 * param whose uses across the query have no common type is reported once, by
 * `ParamSet`, as `param.conflict`.
 *
 * SHARED rather than copied onto the operator, because the three checks are the
 * whole of what "a named-argument call" means and a second copy would drift in
 * exactly the way the A22 fix showed one had already: three of the four
 * call-shaped exprs never observed their params at all, and the fourth did.
 */
export function validateNamedCall(
  words: CallVocabulary,
  name: string,
  declared: readonly DeclaredArg[],
  namedArgs: ReadonlyMap<string, ResolvedType>,
  p: Problems,
  paramArgs: ReadonlySet<string> = EMPTY_PARAM_ARGS,
): void {
  const suppliedLower = words.supplied.toLowerCase();
  for (const param of declared) {
    if (param.optional) continue;
    if (!namedArgs.has(param.name)) {
      p.error(
        `${words.code}.missing-arg`,
        `${words.noun} '${name}' is missing required ${suppliedLower} '${param.name}'.`,
      );
    }
  }

  const byName = new Map(declared.map((param) => [param.name, param]));
  for (const [argName, argType] of namedArgs) {
    const param = byName.get(argName);
    if (!param) {
      p.at(['args', argName], () => {
        p.error(
          `${words.code}.unknown-arg`,
          `${words.noun} '${name}' has no ${words.declared} named '${argName}'.${didYouMean(argName, declared.map((d) => d.name))}`,
        );
      });
      continue;
    }
    const declaredType = param.fieldType;
    if (!declaredType) continue; // 'any' accepts everything
    if (paramArgs.has(argName)) continue; // a bare bind param is TYPED BY this call
    const argFt = asFieldType(argType);
    if (!argFt) {
      p.at(['args', argName], () => {
        p.error(
          `${words.code}.arg-type`,
          `${words.supplied} '${argName}' of '${name}' must be a ${declaredType.resolve()} value (a type cannot be passed here).`,
        );
      });
      continue;
    }
    if (!declaredType.comparableWith(argFt)) {
      p.at(['args', argName], () => {
        p.error(
          `${words.code}.arg-type`,
          `${words.supplied} '${argName}' of '${name}' expects ${declaredType.resolve()}, got ${argFt.resolve()}.`,
        );
      });
    }
  }
}

/**
 * The merge semantics of ONE aggregate CALL: the function's declared
 * {@link AggregateMerge}, reduced to `'none'` when the call is DISTINCT and the
 * declared operation is not idempotent.
 *
 * De-duplication is GLOBAL, not per-group: two groups' `count(DISTINCT x)` values
 * cannot be added, because a value counted in both must be counted once over the
 * union and the per-group results no longer say which values those were. Only the
 * idempotent operations survive it — `min`/`max` over a set are unchanged by
 * duplicates, as are `and`/`or` — so `'sum'` is the single arm DISTINCT cancels.
 *
 * Total by construction: every `AggregateMerge` (and `undefined`, for a function
 * that declares none) maps to an answer, so a consumer never needs a per-function
 * table of its own — the exact hard-coded list this declaration exists to delete.
 */
export function mergeOfAggregateCall(declared: AggregateMerge | undefined, distinct: boolean): AggregateMerge {
  if (declared === undefined) return 'none';
  if (!distinct) return declared;
  return declared === 'sum' ? 'none' : declared;
}

/* v8 ignore start -- compile-time exhaustiveness guard; never invoked at runtime */
/** Compile-time exhaustiveness guard. */
function assertNever(value: never): never {
  throw new Error(`QueryFunction: unhandled output variant ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
