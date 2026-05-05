import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, formatProblem, Code } from '../index';

/**
 * End-to-end: take a deliberately-broken ExprDef, run engine.validate
 * and engine.toGinCode, then assert formatProblem produces a
 * compiler-style render with the offending source line + a `^^^`
 * underline beneath it + the message line.
 *
 * One fixture per validator error code that's actually appeared in
 * recent ginny.log output. If a future change reroutes an error to a
 * different path/span, these snapshots flag it immediately.
 */
describe('formatProblem against rendered code', () => {
  const r = createRegistry();
  const e = new Engine(r);

  test('var.unknown — points at the offending get path', () => {
    // `getNonexistent` is a plain `get` of an unbound name. Validator
    // emits `var.unknown` at path `['path', 0]`. The formatted block
    // should contain the program text + an underline beneath the
    // identifier + the severity-prefixed message.
    const expr = { kind: 'get' as const, path: [{ prop: 'doesNotExist' }] };
    const probs = e.validate(expr);
    const richCode = e.toGinCode(expr);
    const out = formatProblem(richCode, probs.list[0]!);
    expect(out).toContain('doesNotExist');
    // Underline characters present.
    expect(out).toContain('^');
    // Severity label.
    expect(out).toMatch(/error: /);
    // Message body.
    expect(out).toMatch(/unknown variable/);
  });

  test('define.var.type-mismatch — error message in the formatted block', () => {
    // `const x: num = "wrong"` — value is text, declared type is num.
    const expr = {
      kind: 'define' as const,
      vars: [{
        name: 'x',
        type: { name: 'num' as const },
        value: { kind: 'new' as const, type: { name: 'text' as const }, value: 'wrong' },
      }],
      body: { kind: 'get' as const, path: [{ prop: 'x' }] },
    };
    const probs = e.validate(expr);
    const richCode = e.toGinCode(expr);
    const mismatch = probs.list.find((p) => p.code === 'define.var.type-mismatch')!;
    const out = formatProblem(richCode, mismatch);
    expect(out).toContain('"wrong"');
    expect(out).toContain('^');
    expect(out).toMatch(/error: /);
    expect(out).toMatch(/not compatible/);
  });

  test('if.condition.type — points at the bool-mismatched condition', () => {
    // Condition is a num literal; should be bool.
    const expr = {
      kind: 'if' as const,
      ifs: [{
        condition: { kind: 'new' as const, type: { name: 'num' as const }, value: 1 },
        body: { kind: 'new' as const, type: { name: 'text' as const }, value: 'yes' },
      }],
    };
    const probs = e.validate(expr);
    const richCode = e.toGinCode(expr);
    const cond = probs.list.find((p) => p.code === 'if.condition.type');
    expect(cond).toBeDefined();
    const out = formatProblem(richCode, cond!);
    // Should be a warning, not error.
    expect(out).toMatch(/warning: /);
    expect(out).toContain('^');
  });

  test('falls back to path-string format when no span matches', () => {
    // A Code with NO spans at all — the only branch where spanFor
    // returns undefined (an empty path `[]` on a top-level span is
    // always a prefix of any target, so a coarse span always
    // matches if present).
    const bareCode = new Code('some text');
    const fabricated = {
      path: ['nonexistent'] as (string | number)[],
      code: 'fake.error',
      message: 'something fake',
      severity: 'error' as const,
    };
    const out = formatProblem(bareCode, fabricated);
    expect(out).toMatch(/^error: something fake @ nonexistent$/);
  });

  test('color: false produces no ANSI escapes', () => {
    const expr = { kind: 'get' as const, path: [{ prop: 'unknown' }] };
    const probs = e.validate(expr);
    const richCode = e.toGinCode(expr);
    const out = formatProblem(richCode, probs.list[0]!, { color: false });
    expect(out).not.toContain('\x1b[');
  });

  test('color: true emits ANSI on the underline + label', () => {
    const expr = { kind: 'get' as const, path: [{ prop: 'unknown' }] };
    const probs = e.validate(expr);
    const richCode = e.toGinCode(expr);
    const out = formatProblem(richCode, probs.list[0]!, { color: true });
    // Red color code (escape + 31m) somewhere in output.
    expect(out).toContain('\x1b[31m');
  });
});
