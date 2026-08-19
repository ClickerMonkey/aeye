/**
 * OperatorExpr — a REGISTERED operator applied to its named operands
 * (`{ kind:'operator', op:'&&', args:{ left, right } }`).
 *
 * The type analogue of `FunctionCallExpr`, and built from the same parts: it
 * reuses the whole of `_function-args.ts` (parse / resolve / validate /
 * evaluate / observe / serialize / render), because a named-argument call is a
 * named-argument call whichever registry it dispatches through. What differs is
 * exactly two things, and both are the point of the feature:
 *
 *  - **emission is a declared TEMPLATE, not `name(args)`.** A function emits one
 *    shape; an operator emits whatever its `emit` says, per dialect, with its
 *    operands spliced by NAME into the slots. So there is no `orderedArgSql`
 *    here: a template places its operands itself, and ordering them would put
 *    them back in a positional list the template does not read.
 *  - **a dialect that declares no template is REFUSED, never degraded.** See
 *    {@link OperatorExpr.toSQL}.
 */
import { z } from 'zod';
import type { ExprDef, OperatorExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved, ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { QueryTypeError } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { anyAggregate, anyNullable, computed, gatherSources, textResult, childExprSchema } from './_shared';
import { orFold } from '../schema-build';
import { withAid, didYouMean } from '../aids';
import { obj, lit, str, record, exprRef } from '../shape';
import type { FieldType } from '../field-type';
import type { QueryOperator } from '../operator';
import type { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { type NamedArgs, runOperator } from '../runtime/functions';
import {
  parseNamedArgs,
  namedArgSchema,
  resolveNamedArgs,
  validateNamedArgs,
  evaluateNamedArgs,
  observeNamedParams,
  namedArgsToJSON,
  namedArgsToCode,
} from './_function-args';
import type { Cost, CostContext } from '../cost';
import { addCost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { isSlot } from '../sql-template';
import { type SqlContext, SqlText } from '../sql/emit';

/** A registered operator applied to its named operands. */
export class OperatorExpr extends Expr {
  static readonly KIND = 'operator' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A REGISTERED operator (`&&`, `<->`, `@>`) applied to NAMED operands — `{op:'&&', args:{left:…, right:…}}`, keyed by the declared operand name, NOT positional. The operators block of this catalog lists every one that exists here, with its operand types, its result type and what it means; there are no others, and an operator is NOT a function (a function call is `kind:'function-call'`)." as const;
  readonly kind = OperatorExpr.KIND;

  /** Apply the registered operator `op` to its named `args`. */
  constructor(
    readonly op: string,
    /** Operands keyed by declared operand name (insertion order preserved). */
    readonly args: ReadonlyMap<string, Expr>,
  ) {
    super();
  }

  /** Reconstruct an OperatorExpr from its JSON def, parsing named operands via the registry. */
  static from(json: ExprDef, registry: Registry): OperatorExpr {
    if (json.kind !== 'operator') {
      throw new Error(`OperatorExpr.from: expected 'operator', got '${json.kind}'`);
    }
    return new OperatorExpr(json.op, parseNamedArgs(json.args, registry));
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds an
   * `OperatorExpr` equal to `from`'s output on a valid def; the operator-exists
   * / operand checks stay in `validateWalk`, as they do for a function call. See
   * `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('operator'),
      op: str('OperatorName'),
      args: record(exprRef(), 'OperatorArgs'),
    },
    (v) => new OperatorExpr(v.op, v.args),
    { aid: 'Expr_operator' },
  );

  /**
   * Zod schema for this expr kind's JSON shape.
   *
   * `op` is ENUM-LOCKED to the registered operator names whenever a registry is
   * supplied and the `functions` depth axis asks for more than `open` — the same
   * argument that made a refinement's `as` an enum rather than a string: a model
   * free to write `op: '&&'` into a registry that has no `&&` finds out at
   * validate, one whole round trip later. The glossary carries each operator's
   * signature and `instructions` inline, because a bare list of glyphs tells a
   * model what it may write and not what any of them mean.
   *
   * At `typed` depth each operator additionally gets its own STRICT operand
   * object, so a misspelled operand name is refused by the schema rather than by
   * validation. The axis is `functions` rather than an axis of its own: an
   * operator IS a named-argument call, and a caller who asked for loose function
   * calls did not ask for strict operator ones.
   */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    const registered = opts.registry?.operatorList() ?? [];
    const depth = opts.depth?.functions ?? 'open';
    const [first, ...rest] = registered.map((o) => o.name);
    // No registry (a bare `Cls.toSchema()`) or an explicitly open depth ⇒ the
    // free-string shape, matching what a `function-call` renders in the same
    // circumstances.
    if (depth === 'open' || first === undefined) {
      return withAid(
        z.object({
          kind: z.literal('operator'),
          op: z.string().describe('Registered operator name.'),
          args: namedArgSchema(child),
        }),
        'Expr_operator',
      ).describe('A registered operator applied to named operands.');
    }
    const glossary = registered.map((o) => `${signatureOf(o)} — ${o.instructions}`).join(' ');
    if (depth === 'names') {
      return withAid(
        z.object({
          kind: z.literal('operator'),
          op: withAid(z.enum([first, ...rest]), 'OperatorName').describe(`A registered operator. ${glossary}`),
          args: namedArgSchema(child),
        }),
        'Expr_operator',
      ).describe('A registered operator applied to named operands.');
    }
    const branches = registered.map((operator) =>
      withAid(
        z.object({
          kind: z.literal('operator'),
          op: z.literal(operator.name).describe(`${signatureOf(operator)} — ${operator.instructions}`),
          args: z
            .strictObject(Object.fromEntries(operator.operands.map((o) => [o.name, child])))
            .describe(`Operands for \`${operator.name}\`.`),
        }),
        'Expr_operator',
      ),
    );
    return orFold(branches).describe('A registered operator applied to named operands.');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const a of this.args.values()) visit(a);
  }

  protected override aggregateHere(): boolean {
    return false;
  }

  /** Resolve to the operator's DECLARED output type (text fallback when unregistered). */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const operator = engine.lookupOperator(this.op);
    if (!operator) return textResult([], true);
    return this.outputOf(operator, [...resolveNamedArgs(this.args, engine, scope).values()]);
  }

  /**
   * The call's resolved output: the operator's DECLARED type, nullable when any
   * operand is, aggregate when any operand is.
   *
   * Declared, never inferred — an operator exists precisely because its result
   * is not derivable from its operands (`<->` takes two geometries and produces
   * a number), so there is no `'inferred'` arm to mirror.
   */
  private outputOf(operator: QueryOperator, args: readonly ResolvedType[]): ComputedResolved {
    return computed(operator.output, gatherSources(args), anyNullable(args), anyAggregate(args));
  }

  /** Validate the operator exists, observe bind-param operands, then judge the call. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    const argTypes = validateNamedArgs(this.args, engine, scope, p, ctx);

    const operator = engine.lookupOperator(this.op);
    if (!operator) {
      p.error(
        'operator.unknown',
        `Unknown operator '${this.op}'.${didYouMean(this.op, engine.registry.operatorNames())} ` +
          `(registered: ${describeRegistered(engine)}). An operator is not a function — a function is ` +
          "called with `kind:'function-call'`.",
      );
      return textResult([], true);
    }

    // Observe (and re-type) the bare bind-param operands BEFORE the call is
    // judged, for the reason A22 records on the function road: an operand takes
    // its type FROM the declaration, so validating first would refuse
    // `shape && :box` on the `text` placeholder an un-observed param resolves to
    // — order-dependently.
    const paramArgs = observeNamedParams(this.args, operator.operands, engine, scope, here, argTypes);
    operator.validateCall(argTypes, p, paramArgs);

    return this.outputOf(operator, [...argTypes.values()]);
  }

  /** Cost is the operands' child costs plus any intrinsic cost the operator declares. */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    const args = this.childCost(ctx, scope);
    const operator = ctx.engine.lookupOperator(this.op);
    return operator ? addCost(args, operator.cost) : args;
  }

  /**
   * The declared WHERE selectivity, or the base's (keep everything) for an
   * operator that declares none or is not registered here.
   */
  override selectivity(ctx: CostContext, scope: QueryScope): number {
    return ctx.engine.lookupOperator(this.op)?.selectivity ?? super.selectivity(ctx, scope);
  }

  /** Evaluate the operands and run the registered operator implementation. */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    const args: NamedArgs = await evaluateNamedArgs(this.args, ctx, row, group);
    return runOperator(ctx.engine, this.op, args, ctx);
  }

  /**
   * Emit the operator's DECLARED template for this dialect, operands spliced
   * into their named slots.
   *
   * A DIALECT WITH NO DECLARED TEMPLATE IS REFUSED, and that asymmetry with
   * `BaseDialect.emitBuiltinCall` — which degrades silently for builtins
   * (`dateAdd` → the input date unchanged, `arrayContains` → `(1 = 0)`) — is
   * deliberate. A builtin's degrade is portable-SQL policy for a function whose
   * semantics this package owns, documents and tests. A third party cannot
   * document a degrade this package never sees, and `&&` degrading to `(1 = 0)`
   * returns ZERO ROWS for a query the caller believed ran: a wrong answer that
   * looks exactly like a right one. The refusal names the alternatives it can
   * name — the dialects that ARE declared — because a refusal with no remedy
   * costs the retry it was meant to prevent.
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const operator = ctx.engine.lookupOperator(this.op);
    if (!operator) {
      throw new QueryTypeError({
        path: [],
        code: 'operator.unknown',
        severity: 'error',
        message:
          `Unknown operator '${this.op}'.${didYouMean(this.op, ctx.engine.registry.operatorNames())} ` +
          `(registered: ${describeRegistered(ctx.engine)}).`,
      });
    }
    const template = operator.emitFor(dialect.name);
    if (!template) {
      const declared = operator.dialects();
      throw new QueryTypeError({
        path: [],
        code: 'operator.unsupported-dialect',
        severity: 'error',
        message:
          `Operator '${this.op}' declares SQL only for ${declared.map((d) => `\`${d}\``).join(', ')}; this ` +
          `engine emits \`${dialect.name}\`. Rewrite the predicate with a function this dialect has, or ` +
          `register a \`${dialect.name}\` emission for '${this.op}'. It is REFUSED rather than degraded ` +
          'because an operator whose meaning this package does not know cannot be approximated: a ' +
          'silently-neutral fragment returns a confidently wrong answer.',
      });
    }
    const parts: SqlText[] = [];
    for (const part of template) {
      if (!isSlot(part)) {
        parts.push(SqlText.raw(part.text));
        continue;
      }
      const operand = this.args.get(part.slot);
      if (!operand) {
        // Reachable only by emitting a query that was never validated (which
        // would have reported `operator.missing-arg`). Emitting SOMETHING here —
        // a NULL, an omission — is the degrade this whole expr refuses one
        // paragraph above, so it refuses here too.
        throw new QueryTypeError({
          path: ['args', part.slot],
          code: 'operator.missing-arg',
          severity: 'error',
          message:
            `Operator '${this.op}' is missing required operand '${part.slot}', which its \`${dialect.name}\` ` +
            'emission places. Validate the query before emitting it.',
        });
      }
      parts.push(operand.toSQL(dialect, ctx));
    }
    return SqlText.concat(parts);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): OperatorExprDef {
    return {
      kind: 'operator',
      op: this.op,
      args: namedArgsToJSON(this.args),
    };
  }

  /** Deep-copy this expr (and its operand children). */
  clone(): OperatorExpr {
    const cloned = new Map<string, Expr>();
    for (const [k, e] of this.args) cloned.set(k, e.clone());
    return new OperatorExpr(this.op, cloned);
  }

  /**
   * Render the WIRE shape — `&&(left: …, right: …)` — rather than infix.
   *
   * An infix rendering needs the DECLARED operand order, and `toCode()` has no
   * registry to look it up in; rendering in AUTHORED order instead would
   * silently swap the operands of a non-commutative operator, which is worse
   * than reading like a call. It is also honest: the operator IS function-shaped
   * on the wire, and this is a debugging rendering of the authored tree, not of
   * the SQL. Infix appears where infix is real — in the emitted SQL.
   */
  override toCode(): string {
    return `${this.op}(${namedArgsToCode(this.args)})`;
  }
}

/**
 * `&&(left: json as Geometry, right: json as Geometry) → bool` — one operator's
 * model-facing signature, for the `op` enum's glossary.
 *
 * The registered NAME rides beside the base kind because that is the whole
 * question a reader has here: two operators over `json` are two different
 * vocabularies, and a glossary that showed only the base would say the same
 * thing about both. Rendered from the field type's own accessors rather than
 * through `llm/describe.ts`'s richer tag, so an expr class stays independent of
 * the description layer.
 */
function signatureOf(operator: QueryOperator): string {
  const operands = operator.operands.map((o) => `${o.name}: ${typeOf(o.fieldType)}`).join(', ');
  return `${operator.name}(${operands}) → ${typeOf(operator.output)}`;
}

/** `json as Geometry` / `bool` / `any` — a declared operand or output type, terse. */
function typeOf(ft: FieldType | undefined): string {
  if (!ft) return 'any';
  return ft.as === undefined ? ft.resolve() : `${ft.resolve()} as ${ft.as}`;
}

/** The registered operator names for a diagnostic, or a note that there are none. */
function describeRegistered(engine: QueryEngine): string {
  const names = engine.registry.operatorNames();
  return names.length > 0 ? names.join(', ') : 'none — no operator is registered on this engine';
}

const _check: ExprClass = OperatorExpr;
void _check;
