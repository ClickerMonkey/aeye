import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, SchemaOptions } from '../index';
import type { ExprDef } from '../schema';
import { Expr } from '../expr';
import { val } from '../value';
import type { Registry } from '../registry';
import type { Scope } from '../scope';
import { z } from 'zod';
 
/**
 * No central switch on expr.kind or type.name: each piece dispatches through
 * polymorphic methods. Users can add new expression kinds by subclassing
 * Expr, or new type classes by subclassing Type, without touching
 * engine/analysis/code-emit.
 */

describe('extensibility: user-defined expr class', () => {
  test('subclassing Expr gives engine/typeOf/validate/toCode for free', async () => {
    interface DoubleExprDef extends ExprDef {
      kind: 'test.double';
      input: ExprDef;
    }

    class DoubleExpr extends Expr {
      static readonly KIND = 'test.double';
      readonly kind = DoubleExpr.KIND;

      constructor(readonly input: Expr) { super(); }

      static from(json: DoubleExprDef, registry: Registry): DoubleExpr {
        return new DoubleExpr(registry.parseExpr(json.input));
      }

      static toSchema(opts: SchemaOptions): z.ZodTypeAny {
        return z.object({
          kind: z.literal('test.double'),
          input: z.lazy(() => opts.Expr),
        });
      }

      async evaluate(engine: Engine, scope: Scope) {
        const inner = await this.input.evaluate(engine, scope);
        return val(engine.registry.num(), (inner.raw as number) * 2);
      }

      typeOf(engine: Engine) { return engine.registry.num(); }

      validateWalk(engine: Engine) { return engine.registry.num(); }

      toCode(registry: Registry) {
        return `(${this.input.toCode(registry)} * 2)`;
      }

      toJSON(): DoubleExprDef {
        return { kind: 'test.double', input: this.input.toJSON() };
      }
      
      clone(): DoubleExpr {
        return new DoubleExpr(this.input.clone());
      }
    }

    const r = createRegistry();
    r.defineExpr(DoubleExpr);

    const e = new Engine(r);
    const expr: DoubleExprDef = {
      kind: 'test.double',
      input: { kind: 'new', type: { name: 'num' }, value: 21 },
    };

    expect((await e.run(expr)).raw).toBe(42);
    expect(e.typeOf(expr).name).toBe('num');
    expect(e.validate(expr).list).toEqual([]);
    expect(e.toCode(expr)).toBe('(21 * 2)');
  });
});

describe('extensibility: Type.isOptional is polymorphic', () => {
  test('optional returns true; other types return false', () => {
    const r = createRegistry();
    expect(r.optional(r.num()).isOptional()).toBe(true);
    expect(r.num().isOptional()).toBe(false);
    expect(r.text().isOptional()).toBe(false);
    expect(r.nullable(r.num()).isOptional()).toBe(false);
    expect(r.or([r.num(), r.text()]).isOptional()).toBe(false);
  });

  test('obj renders name? only for optional fields', () => {
    const r = createRegistry();
    const t = r.obj({
      required: { type: r.num() },
      maybe:    { type: r.optional(r.text()) },
      nullable: { type: r.nullable(r.num()) },
    });
    expect(t.toCode()).toBe('obj{required: num, maybe?: text, nullable: nullable<num>}');
  });
});

describe('extensibility: Type.toCode is fully polymorphic', () => {
  test('every built-in type implements toCode without a central switch', () => {
    const r = createRegistry();
    // Sample from each category — just verify nothing throws.
    const samples = [
      r.any(), r.void(), r.null(), r.bool(), r.num(), r.text(),
      r.list(r.num()), r.map(r.text(), r.bool()), r.tuple([r.num(), r.text()]),
      r.obj({ x: { type: r.num() } }),
      r.optional(r.num()), r.nullable(r.num()), r.not(r.num()),
      r.or([r.num(), r.text()]), r.and([r.obj({ a: { type: r.num() } }), r.obj({ b: { type: r.text() } })]),
      r.enum({ A: 'a' }, r.text()), r.literal(r.num(), 7),
      r.fn({ args: r.obj({}), returns: r.num() }),
      r.iface({ props: { x: { type: { name: 'num' } } } }),
      r.alias('Foo'), r.alias('T'),
      r.date(), r.timestamp(), r.duration(), r.color(),
      r.extend('num', { name: 'Positive', options: { min: 0 } }),
    ];
    for (const t of samples) {
      const code = t.toCode();
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});
