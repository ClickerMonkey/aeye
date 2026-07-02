/**
 * autoPaginate — binds `limit` / `offset` to named params when absent, leaves
 * already-present bounds untouched, and is idempotent.
 */
import { describe, it, expect } from 'vitest';
import { autoPaginate } from '../transforms/index';
import type { SelectDef, ParamExprDef } from '../schema';

/** A minimal paginatable select def. */
function baseSelect(): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
  };
}

/** Whether a bound is a param expr with the given name. */
function isParam(value: number | ParamExprDef | undefined, name: string): boolean {
  return typeof value === 'object' && value !== undefined && value.kind === 'param' && value.name === name;
}

describe('autoPaginate', () => {
  it('adds limit + offset params when neither is present', () => {
    const out = autoPaginate(baseSelect());
    expect(isParam(out.limit, 'limit')).toBe(true);
    expect(isParam(out.offset, 'offset')).toBe(true);
  });

  it('honors custom param names', () => {
    const out = autoPaginate(baseSelect(), { limitParam: 'take', offsetParam: 'skip' });
    expect(isParam(out.limit, 'take')).toBe(true);
    expect(isParam(out.offset, 'skip')).toBe(true);
  });

  it('leaves an already-present literal limit untouched, only adds offset', () => {
    const out = autoPaginate({ ...baseSelect(), limit: 25 });
    expect(out.limit).toBe(25);
    expect(isParam(out.offset, 'offset')).toBe(true);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = autoPaginate(baseSelect());
    const twice = autoPaginate(once);
    expect(twice).toEqual(once);
  });

  it('never mutates its input', () => {
    const input = baseSelect();
    autoPaginate(input);
    expect(input.limit).toBeUndefined();
    expect(input.offset).toBeUndefined();
  });
});
