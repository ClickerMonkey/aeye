/**
 * The `shape/` combinators reach the PACKAGE BARREL.
 *
 * `parseCheckedExpr` / `parseCheckedQuery` dispatch on each class's owned
 * `static SHAPE`, and a kind with none is refused outright with
 * `shape.unknown-kind`. Through 0.6.6 the combinators that BUILD a `SHAPE`
 * (`obj`, `lit`, `str`, `json`, `record`, `exprRef`, …) were exported from
 * `src/shape/index.ts` and from nowhere else, so a class defined outside this
 * package could satisfy `defineExpr` — validating, costing, emitting SQL and
 * describing itself correctly — and still be refused by the CHECKED parser,
 * which is the gate an LLM-authored query goes through.
 *
 * They are exported as the NAMESPACE `shape` rather than flattened, because
 * `lit` would otherwise shadow the expression builder's `lit`; this test pins
 * both the namespace and that its members are the same bindings.
 *
 * SCOPE, stated so the next reader does not over-read it: this makes a `SHAPE`
 * AUTHORABLE outside the package. It does not open `ExprKind` (`ExprDef['kind']`
 * — a closed union, deliberately: parse dispatch stays the library's), so a
 * genuinely new kind still needs a library release. What a consumer can do
 * today is own the shape of a kind it defines a class for.
 */
import { describe, it, expect } from 'vitest';
import { shape, type Shape, type CheckCtx } from '../index';
import * as shapeModule from '../shape/index';
import { createRegistry } from '../index';
import { Problems } from '../index';
import { LiteralExpr } from '../index';
import type { Expr, ExprDef, Registry } from '../index';

/** A `CheckCtx` over a fresh registry — what `parseCheckedExpr` threads in. */
function ctxFor(registry: Registry, problems: Problems): CheckCtx {
  return { problems, registry };
}

describe('the shape combinators on the public barrel', () => {
  it('exports the SAME bindings as the shape module, under a namespace', () => {
    expect(shape.obj).toBe(shapeModule.obj);
    expect(shape.lit).toBe(shapeModule.lit);
    expect(shape.str).toBe(shapeModule.str);
    expect(shape.exprRef).toBe(shapeModule.exprRef);
    expect(shape.INVALID).toBe(shapeModule.INVALID);
  });

  it('builds a working Shape from the barrel alone (accumulating, never throwing)', () => {
    const registry = createRegistry();
    // Authored exactly as a consumer would, with nothing imported from a deep
    // path: two fields, one of them a nested child expr.
    const s: Shape<{ kind: 'demo'; name: string; operand: Expr }> = shape.obj(
      {
        kind: shape.lit('demo'),
        name: shape.str('FieldName'),
        operand: shape.exprRef(),
      },
      (v) => v,
      { aid: 'Expr' },
    );

    const good = new Problems();
    const built = s.check(
      { kind: 'demo', name: 'x', operand: { kind: 'literal', value: 1 } },
      ctxFor(registry, good),
    );
    expect(good.list).toEqual([]);
    expect(built === shape.INVALID ? undefined : built?.operand).toBeInstanceOf(LiteralExpr);

    // Two bad fields, ONE pass: the combinators accumulate rather than throw.
    const bad = new Problems();
    expect(s.check({ kind: 'demo', name: 7, operand: 'nope' }, ctxFor(registry, bad))).toBe(shape.INVALID);
    expect(bad.list.length).toBe(2);
    expect(bad.list.every((x) => x.code.startsWith('shape.'))).toBe(true);
  });

  it('a class defined OUTSIDE the package can own the checked parse of its kind', () => {
    /**
     * A consumer-side class whose `SHAPE` is authored from the barrel: it
     * accepts only a STRING literal, so the checked parser refuses
     * `{kind:'literal', value: 1}` where the shipped shape allows it. That
     * difference is the proof the registered SHAPE is the one being dispatched.
     */
    class StringLiteralExpr extends LiteralExpr {
      static override readonly SHAPE = shape.obj(
        {
          kind: shape.lit('literal'),
          value: shape.str('LiteralValue'),
        },
        (v) => new LiteralExpr(v.value),
        { aid: 'Expr_literal' },
      );
    }

    const registry = createRegistry();
    registry.defineExpr(StringLiteralExpr);

    const ok = new Problems();
    const expr = registry.parseCheckedExpr({ kind: 'literal', value: 'hi' } satisfies ExprDef, ok);
    expect(ok.list).toEqual([]);
    expect(expr).toBeInstanceOf(LiteralExpr);

    const refused = new Problems();
    expect(registry.parseCheckedExpr({ kind: 'literal', value: 1 } satisfies ExprDef, refused)).toBeUndefined();
    expect(refused.list.map((x) => x.code)).toEqual(['shape.type']);

    // And the shipped shape is unaffected in a registry that did not opt in.
    const untouched = new Problems();
    expect(createRegistry().parseCheckedExpr({ kind: 'literal', value: 1 }, untouched)).toBeInstanceOf(LiteralExpr);
    expect(untouched.list).toEqual([]);
  });
});
