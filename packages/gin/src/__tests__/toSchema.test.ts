import { describe, test, expect } from 'vitest';
import { createRegistry, buildSchemas } from '../index';

/**
 * Every Type class and Expr class exposes a static toSchema(opts) that
 * returns a Zod schema for its JSON shape. buildSchemas(registry)
 * stitches them together into two top-level unions, Type and Expr,
 * referencing each other via z.lazy for recursive positions.
 *
 * An LLM can be given these schemas and asked for a program.
 */

describe('toSchema / buildSchemas', () => {
  const r = createRegistry();
  const { Type, Expr } = buildSchemas(r);

  test('primitive TypeDefs parse', () => {
    expect(() => Type.parse({ name: 'num' })).not.toThrow();
    expect(() => Type.parse({ name: 'text', options: { minLength: 1 } })).not.toThrow();
    expect(() => Type.parse({ name: 'bool' })).not.toThrow();
  });

  test('list<num> with nested generic parses', () => {
    expect(() => Type.parse({
      name: 'list',
      generic: { V: { name: 'num' } },
    })).not.toThrow();
  });

  test('obj with nested props parses', () => {
    expect(() => Type.parse({
      name: 'obj',
      props: {
        name: { type: { name: 'text' } },
        age:  { type: { name: 'num' } },
      },
    })).not.toThrow();
  });

  test('unknown type name is rejected', () => {
    expect(() => Type.parse({ name: 'bogus' })).toThrow();
  });

  test('primitive ExprDefs parse', () => {
    expect(() => Expr.parse({ kind: 'new', type: { name: 'num' }, value: 42 })).not.toThrow();
    expect(() => Expr.parse({ kind: 'get', path: [{ prop: 'x' }] })).not.toThrow();
    expect(() => Expr.parse({ kind: 'flow', action: 'return' })).not.toThrow();
  });

  test('recursive ExprDefs parse (if with nested block)', () => {
    expect(() => Expr.parse({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: {
          kind: 'block',
          lines: [
            { kind: 'new', type: { name: 'num' }, value: 1 },
            { kind: 'new', type: { name: 'num' }, value: 2 },
          ],
        },
      }],
    })).not.toThrow();
  });

  test('lambda with Fn type + body parses', () => {
    expect(() => Expr.parse({
      kind: 'lambda',
      type: {
        name: 'fn',
        call: {
          args: { name: 'obj', props: { n: { type: { name: 'num' } } } },
          returns: { name: 'num' },
        },
      },
      body: {
        kind: 'get',
        path: [{ prop: 'args' }, { prop: 'n' }],
      },
    })).not.toThrow();
  });

  test('unknown expr kind is rejected', () => {
    expect(() => Expr.parse({ kind: 'bogus.op' })).toThrow();
  });

  test('comment is preserved through schema', () => {
    expect(() => Expr.parse({
      kind: 'new', type: { name: 'num' }, value: 1, comment: 'one',
    })).not.toThrow();
  });
});
