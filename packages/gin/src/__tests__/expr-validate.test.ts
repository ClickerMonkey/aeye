import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Validation rules audit — every Expr's validateWalk checks structural
 * type shape beyond just walking children. One test per rule.
 */

const e = new Engine(createRegistry());

describe('IfExpr validation', () => {
  test('non-bool condition → warn', () => {
    const probs = e.validate({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'num' }, value: 1 },
        body: { kind: 'new', type: { name: 'num' }, value: 42 },
      }],
    });
    expect(probs.list.some((p) => p.code === 'if.condition.type')).toBe(true);
  });

  test('bool condition → no warn', () => {
    const probs = e.validate({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'new', type: { name: 'num' }, value: 42 },
      }],
    });
    expect(probs.list.some((p) => p.code === 'if.condition.type')).toBe(false);
  });
});

describe('SwitchExpr validation', () => {
  test('case value incompatible with switch value → warn', () => {
    const probs = e.validate({
      kind: 'switch',
      value: { kind: 'new', type: { name: 'num' }, value: 1 },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'text' }, value: 'x' }],
        body: { kind: 'new', type: { name: 'num' }, value: 0 },
      }],
    });
    expect(probs.list.some((p) => p.code === 'switch.case.type')).toBe(true);
  });

  test('compatible case values → no warn', () => {
    const probs = e.validate({
      kind: 'switch',
      value: { kind: 'new', type: { name: 'num' }, value: 1 },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 2 }],
        body: { kind: 'new', type: { name: 'num' }, value: 0 },
      }],
    });
    expect(probs.list.some((p) => p.code === 'switch.case.type')).toBe(false);
  });
});

describe('LambdaExpr validation', () => {
  test('body type incompatible with declared returns → warn', () => {
    const probs = e.validate({
      kind: 'lambda',
      type: { name: 'fn', call: {
        args: { name: 'obj' },
        returns: { name: 'num' },
      } },
      body: { kind: 'new', type: { name: 'text' }, value: 'wrong' },
    });
    expect(probs.list.some((p) => p.code === 'lambda.returns.type')).toBe(true);
  });

  test('body type matches declared returns → no warn', () => {
    const probs = e.validate({
      kind: 'lambda',
      type: { name: 'fn', call: {
        args: { name: 'obj' },
        returns: { name: 'num' },
      } },
      body: { kind: 'new', type: { name: 'num' }, value: 42 },
    });
    expect(probs.list.some((p) => p.code === 'lambda.returns.type')).toBe(false);
  });
});

describe('TemplateExpr validation', () => {
  test('non-text template → warn', () => {
    const probs = e.validate({
      kind: 'template',
      template: { kind: 'new', type: { name: 'num' }, value: 42 },
      params: { kind: 'new', type: { name: 'obj', props: {} }, value: {} },
    });
    expect(probs.list.some((p) => p.code === 'template.template.type')).toBe(true);
  });

  test('non-object params → warn', () => {
    const probs = e.validate({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'hi' },
      params: { kind: 'new', type: { name: 'num' }, value: 1 },
    });
    expect(probs.list.some((p) => p.code === 'template.params.type')).toBe(true);
  });

  test('text template + obj params → no warn', () => {
    const probs = e.validate({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'hi' },
      params: { kind: 'new', type: { name: 'obj', props: {} }, value: {} },
    });
    expect(probs.list.some((p) => p.code === 'template.template.type')).toBe(false);
    expect(probs.list.some((p) => p.code === 'template.params.type')).toBe(false);
  });
});

describe('SetExpr validation', () => {
  test('value incompatible with target → warn', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{
        name: 'arr',
        value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1] },
      }],
      body: {
        kind: 'set',
        path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
        value: { kind: 'new', type: { name: 'text' }, value: 'wrong' },
      },
    });
    expect(probs.list.some((p) => p.code === 'set.type-mismatch')).toBe(true);
  });

  test('value matches target type → no warn', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{
        name: 'arr',
        value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1] },
      }],
      body: {
        kind: 'set',
        path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
        value: { kind: 'new', type: { name: 'num' }, value: 99 },
      },
    });
    expect(probs.list.some((p) => p.code === 'set.type-mismatch')).toBe(false);
  });
});

describe('DefineExpr validation', () => {
  test('declared var type incompatible with value → error', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{
        name: 'x',
        type: { name: 'num' },
        value: { kind: 'new', type: { name: 'text' }, value: 'hi' },
      }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    const mismatch = probs.list.find((p) => p.code === 'define.var.type-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe('error');
  });

  test('declared var type matches value → no error', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{
        name: 'x',
        type: { name: 'num' },
        value: { kind: 'new', type: { name: 'num' }, value: 42 },
      }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(probs.list.some((p) => p.code === 'define.var.type-mismatch')).toBe(false);
  });
});
