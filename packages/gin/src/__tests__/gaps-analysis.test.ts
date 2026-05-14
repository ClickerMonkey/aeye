import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

describe('Engine.typeOf', () => {
  const e = new Engine(createRegistry());

  test('new returns the declared type', () => {
    const t = e.typeOf({ kind: 'new', type: { name: 'num' }, value: 7 });
    expect(t.name).toBe('num');
  });

  test('lambda returns the declared fn type', () => {
    const t = e.typeOf({
      kind: 'lambda',
      type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'text' } } },
      body: { kind: 'new', type: { name: 'text' }, value: 'hi' },
    } as any);
    expect(t.name).toBe('fn');
  });

  test('block returns last line type', () => {
    const t = e.typeOf({
      kind: 'block',
      lines: [
        { kind: 'new', type: { name: 'num' }, value: 1 },
        { kind: 'new', type: { name: 'text' }, value: 'x' },
      ],
    });
    expect(t.name).toBe('text');
  });

  test('if-chain returns union of branch types', () => {
    const t = e.typeOf({
      kind: 'if',
      ifs: [
        { condition: { kind: 'new', type: { name: 'bool' }, value: true }, body: { kind: 'new', type: { name: 'num' }, value: 1 } },
      ],
      else: { kind: 'new', type: { name: 'text' }, value: 'x' },
    });
    expect(t.name).toBe('or');
  });

  test('define extends scope for body', () => {
    const t = e.typeOf({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(t.name).toBe('num');
  });

  test('get walks path and returns final type', () => {
    const t = e.typeOf({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    });
    expect(t.name).toBe('num');
  });

  test('loop returns void', () => {
    const t = e.typeOf({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'num' }, value: 5 },
      body: { kind: 'new', type: { name: 'void' } },
    } as any);
    expect(t.name).toBe('void');
  });

  test('template returns text', () => {
    const t = e.typeOf({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: '' },
      params: { kind: 'new', type: { name: 'obj', props: {} }, value: {} },
    } as any);
    expect(t.name).toBe('text');
  });
});

describe('Engine.validate', () => {
  const e = new Engine(createRegistry());

  test('no problems for well-formed expr', () => {
    const p = e.validate({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(p.hasErrors).toBe(false);
  });

  test('flags unknown variable', () => {
    const p = e.validate({ kind: 'get', path: [{ prop: 'missing' }] });
    expect(p.hasErrors).toBe(true);
    expect(p.list.find((x) => x.code === 'var.unknown')).toBeDefined();
  });

  test('flags unknown prop on known type', () => {
    const p = e.validate({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      body: { kind: 'get', path: [{ prop: 'x' }, { prop: 'nonExistent' }] },
    });
    expect(p.hasErrors).toBe(true);
    expect(p.list.find((x) => x.code === 'prop.unknown')).toBeDefined();
  });

  test('flags break outside loop', () => {
    const p = e.validate({ kind: 'flow', action: 'break' } as any);
    expect(p.list.find((x) => x.code === 'flow.outside-loop')).toBeDefined();
  });

  test('break inside loop is fine', () => {
    const p = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'num' }, value: 3 },
      body: { kind: 'flow', action: 'break' },
    } as any);
    expect(p.list.find((x) => x.code === 'flow.outside-loop')).toBeUndefined();
  });

  test('throw without error is flagged', () => {
    const p = e.validate({ kind: 'flow', action: 'throw' } as any);
    expect(p.list.find((x) => x.code === 'flow.throw.no-error')).toBeDefined();
  });

  test('warns on unregistered native id', () => {
    const p = e.validate({ kind: 'native', id: 'made.up.id' });
    expect(p.list.find((x) => x.code === 'native.unknown')).toBeDefined();
  });
});
