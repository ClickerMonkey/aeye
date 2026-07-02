/**
 * Coverage: QueryEngine constructor backings, registerExecutor, coerceQuery,
 * validateQuery executor.validate hook, toSQL unknown-dialect, and the
 * Expr-instance vs ExprDef coercion in resolveExpr / validateExpr.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { runtimeFixture, userTypeDef, orderTypeDef, ref } from './_utils';
import type { TypeExecutor } from '../runtime/executor';
import type { SelectDef } from '../schema';

function baseEngine() {
  const registry = createRegistry();
  registry.registerType(registry.parseType(userTypeDef));
  registry.registerType(registry.parseType(orderTypeDef));
  registry.finalize();
  return { registry };
}

describe('QueryEngine wiring', () => {
  it('accepts config backings + registerExecutor', () => {
    const { registry } = baseEngine();
    const engine = new QueryEngine(registry, { backings: { user: { name: 'users_tbl' } } });
    expect(engine.sourceTable('user')).toBe('users_tbl');
    engine.registerExecutor('user', arrayExecutor([]));
    expect(engine.executor('user')).toBeDefined();
  });

  it('coerceQuery passes a parsed Query through and parses a def', () => {
    const { registry } = baseEngine();
    const engine = new QueryEngine(registry);
    const def: SelectDef = { kind: 'select', fields: [{ expr: ref('user', 'id'), as: 'id' }], from: { kind: 'type', type: 'user' } };
    const parsed = engine.parseQuery(def);
    expect(engine.coerceQuery(parsed)).toBe(parsed);
    expect(engine.coerceQuery(def).kind).toBe('select');
  });

  it('toSQL throws for an unknown dialect', () => {
    const { registry } = baseEngine();
    const engine = new QueryEngine(registry);
    const def: SelectDef = { kind: 'select', fields: [{ expr: ref('user', 'id'), as: 'id' }], from: { kind: 'type', type: 'user' } };
    expect(() => engine.toSQL(def, 'nope')).toThrow(/unknown dialect/);
  });

  it('validateQuery invokes a Type executor validate hook', () => {
    const { registry } = baseEngine();
    let called = false;
    const executor: TypeExecutor = {
      load: async () => [],
      validate: (_q, p) => {
        called = true;
        p.warn('custom', 'checked');
      },
    };
    const engine = new QueryEngine(registry, { executors: { user: executor } });
    const def: SelectDef = { kind: 'select', fields: [{ expr: ref('user', 'id'), as: 'id' }], from: { kind: 'type', type: 'user' } };
    const problems = engine.validateQuery(def);
    expect(called).toBe(true);
    expect(problems.list.some((pr) => pr.code === 'custom')).toBe(true);
  });

  it('resolveExpr / validateExpr accept both a parsed Expr and an ExprDef', () => {
    const fx = runtimeFixture();
    const scope = fx.engine.globalScope();
    scope.bind('user', { kind: 'type', type: fx.user, source: 'user', synthetic: false });
    const parsed = fx.engine.parse(ref('user', 'id'));
    expect(fx.engine.resolveExpr(parsed, scope).kind).toBe('field');
    expect(fx.engine.resolveExpr(ref('user', 'id'), scope).kind).toBe('field');
    expect(fx.engine.validateExpr(parsed, scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(ref('user', 'id'), scope).hasErrors).toBe(false);
    // No explicit scope → engine.globalScope() default (a bare literal resolves).
    expect(fx.engine.resolveExpr({ kind: 'literal', value: 1 }).kind).toBe('computed');
    expect(fx.engine.validateExpr({ kind: 'literal', value: 1 }).hasErrors).toBe(false);
  });
});
