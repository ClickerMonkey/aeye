import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { IfaceType } from '../types/iface';

describe('IfaceType', () => {
  const r = createRegistry();

  test('builder accepts a spec', () => {
    const i = r.iface({
      props: {
        toText: { type: { name: 'function', call: { args: { name: 'object' }, returns: { name: 'text' } } } },
      },
    });
    expect(i).toBeInstanceOf(IfaceType);
  });

  test('compatible: type that has matching props satisfies interface', () => {
    const i = r.iface({
      props: {
        toText: { type: { name: 'function', call: { args: { name: 'object' }, returns: { name: 'text' } } } },
      },
    });
    // num has toText — should satisfy
    expect(i.compatible(r.num())).toBe(true);
  });

  test('compatible: type missing required prop fails', () => {
    const i = r.iface({
      props: {
        missingProp: { type: { name: 'any' } },
      },
    });
    expect(i.compatible(r.num())).toBe(false);
  });

  test('flexible is true (structural acceptor)', () => {
    expect(r.iface({}).flexible()).toBe(true);
  });

  test('props/get/call are natively consumed → no auto-Extension', () => {
    const json = {
      name: 'interface',
      props: { foo: { type: { name: 'any' } } },
    };
    const back = r.parse(json);
    expect(back).toBeInstanceOf(IfaceType);
  });

  test('encode + parse roundtrip', () => {
    const i = r.iface({
      props: { x: { type: { name: 'num' } } },
    });
    const back = r.parse(i.toJSON()) as IfaceType;
    expect(back).toBeInstanceOf(IfaceType);
    expect(back.props().x).toBeDefined();
  });
});
