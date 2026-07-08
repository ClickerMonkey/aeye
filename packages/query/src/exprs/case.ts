/**
 * CaseExpr — `CASE WHEN <cond> THEN <result> [...] [ELSE <result>] END`.
 * Resolves to the type of its result branches (mirroring the first `then`).
 * Each `when` must be boolean; `then`/`else` branches should be mutually
 * comparable. Nullable when there is no `else` (an unmatched CASE yields
 * NULL) or any result branch is nullable.
 */
import { z } from 'zod';
import type { CaseExprDef, ExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import { asFieldType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { computed, gatherSources, categoryOf, childExprSchema } from './_shared';
import { withAid } from '../aids';
import { obj, lit, list, exprRef } from '../shape';
import { TextFieldType } from '../field-types/index';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

interface CaseBranch {
  when: Expr;
  then: Expr;
}

/** Structural shape for one `{ when, then }` branch (drives the owned SHAPE's `list`). */
const BRANCH_SHAPE = obj(
  { when: exprRef(), then: exprRef() },
  (v): CaseBranch => ({ when: v.when, then: v.then }),
  { aid: 'CaseBranch' },
);

/** A `CASE WHEN … THEN … [ELSE …] END` expression. */
export class CaseExpr extends Expr {
  static readonly KIND = 'case' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`CASE WHEN … THEN … [ELSE …] END`." as const;
  readonly kind = CaseExpr.KIND;

  /** Wrap the `WHEN/THEN` branches and an optional `ELSE` result. */
  constructor(
    readonly branches: CaseBranch[],
    readonly els: Expr | undefined,
  ) {
    super();
  }

  /** Reconstruct a CaseExpr from its JSON def, recursing into each branch/else via the registry. */
  static from(json: ExprDef, registry: Registry): CaseExpr {
    if (json.kind !== 'case') {
      throw new Error(`CaseExpr.from: expected 'case', got '${json.kind}'`);
    }
    const branches = json.branches.map((b) => ({
      when: registry.parseExpr(b.when),
      then: registry.parseExpr(b.then),
    }));
    const els = json.else ? registry.parseExpr(json.else) : undefined;
    return new CaseExpr(branches, els);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `CaseExpr` equal to `from`'s output on a valid def (`else` omitted when
   * absent); accumulates every bad branch / else in one pass (never throws).
   * See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('case'),
      branches: list(BRANCH_SHAPE),
      else: exprRef(),
    },
    (v) => new CaseExpr(v.branches, v.else),
    { optional: ['else'], aid: 'Expr_case' },
  );

  /** Zod schema for this expr kind's JSON shape (when/then branch slots and an optional else). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    return withAid(
      z.object({
        kind: z.literal('case'),
        branches: z.array(z.object({ when: child, then: child })),
        else: child.optional(),
      }),
      'Expr_case',
    ).describe('Conditional CASE expression.');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const b of this.branches) {
      visit(b.when);
      visit(b.then);
    }
    if (this.els) visit(this.els);
  }

  /** All result branches (`then`s plus the optional `else`). */
  private results(engine: QueryEngine, scope: QueryScope): ResolvedType[] {
    const out = this.branches.map((b) => b.then.resolve(engine, scope));
    if (this.els) out.push(this.els.resolve(engine, scope));
    return out;
  }

  /** Resolve to the result branches' type (mirroring the first `then`), nullable without an `else`. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const results = this.results(engine, scope);
    const whens = this.branches.map((b) => b.when.resolve(engine, scope));
    const all = [...whens, ...results];
    // Result category mirrors the first `then` branch (else `else`).
    const sample = results[0];
    const fieldType = (sample ? asFieldType(sample) : undefined) ?? new TextFieldType();
    const nullable =
      !this.els ||
      results.some((r) => r.kind !== 'type' && r.nullable);
    const aggregate = all.some((r) => r.kind === 'computed' && r.aggregate);
    return computed(fieldType, gatherSources(all), nullable, aggregate);
  }

  /** Validate each `when` is boolean and warn when result branches are not mutually comparable. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    p.at('branches', () => {
      this.branches.forEach((b, i) => {
        p.at(i, () => {
          const whenRt = p.at('when', () => b.when.validateWalk(engine, scope, p, ctx));
          p.at('then', () => b.then.validateWalk(engine, scope, p, ctx));
          if (categoryOf(whenRt) !== 'bool') {
            p.at('when', () =>
              p.error(
                'case.when-non-bool',
                `CASE branch ${i} 'when' must be boolean; got ${categoryOf(whenRt) ?? 'a type'}.`,
              ),
            );
          }
        });
      });
    });
    if (this.els) p.at('else', () => this.els!.validateWalk(engine, scope, p, ctx));

    // Result-branch comparability (warning — coercion may still be intended).
    const results = this.results(engine, scope);
    const firstFt = asFieldType(results[0]!);
    if (firstFt) {
      results.forEach((r, i) => {
        const ft = asFieldType(r);
        if (ft && !firstFt.comparableWith(ft)) {
          p.warn(
            'case.then-mismatch',
            `CASE result branch ${i} (${ft.resolve()}) differs from the first branch (${firstFt.resolve()}).`,
          );
        }
      });
    }

    return this.resolve(engine, scope);
  }

  /** Cost is the sum of the child branch costs. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return this.childCost(engine, scope);
  }

  /** Return the first matching branch's result, else the `else` result, else NULL. */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    if (row) {
      for (const b of this.branches) {
        const when = await b.when.evaluate(ctx, row, group);
        if (when.toBoolean()) return b.then.evaluate(ctx, row, group);
      }
    }
    if (this.els) return this.els.evaluate(ctx, row, group);
    return Value.null();
  }

  /** Emit `CASE WHEN … THEN … [ELSE …] END`. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const parts: SqlText[] = [SqlText.raw('CASE')];
    for (const b of this.branches) {
      parts.push(SqlText.raw('WHEN'), b.when.toSQL(dialect, ctx), SqlText.raw('THEN'), b.then.toSQL(dialect, ctx));
    }
    if (this.els) parts.push(SqlText.raw('ELSE'), this.els.toSQL(dialect, ctx));
    parts.push(SqlText.raw('END'));
    return SqlText.join(parts, ' ');
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): CaseExprDef {
    const def: CaseExprDef = {
      kind: 'case',
      branches: this.branches.map((b) => ({ when: b.when.toJSON(), then: b.then.toJSON() })),
    };
    if (this.els) def.else = this.els.toJSON();
    return def;
  }

  /** Deep-copy this expr (and its branch/else children). */
  clone(): CaseExpr {
    return new CaseExpr(
      this.branches.map((b) => ({ when: b.when.clone(), then: b.then.clone() })),
      this.els?.clone(),
    );
  }

  /** Render a human-readable source form of this CASE expression. */
  override toCode(): string {
    const parts = this.branches.map((b) => `WHEN ${b.when.toCode()} THEN ${b.then.toCode()}`);
    if (this.els) parts.push(`ELSE ${this.els.toCode()}`);
    return `CASE ${parts.join(' ')} END`;
  }
}

const _check: ExprClass = CaseExpr;
void _check;
