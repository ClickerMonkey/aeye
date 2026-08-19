/**
 * Coverage: Registry lookups, function-name validation, run-shape mismatch,
 * unknown-kind parse throws, and finalize inverse-relation edge branches.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import type { TypeDef } from '../schema';

describe('Registry class lookups', () => {
  const r = createRegistry();
  it('fieldTypeClass / exprClass / queryClass resolve builtins + miss', () => {
    expect(r.fieldTypeClass('text')).toBeDefined();
    expect(r.fieldTypeClass('nope')).toBeUndefined();
    expect(r.exprClass('literal')).toBeDefined();
    expect(r.exprClass('nope')).toBeUndefined();
    expect(r.queryClass('select')).toBeDefined();
    expect(r.queryClass('nope')).toBeUndefined();
  });
});

describe('Registry function registration guards', () => {
  it('rejects an unsafe function name', () => {
    const r = createRegistry();
    expect(() => r.registerFunction({ name: 'bad-name!', shape: 'scalar', params: [], output: { kind: 'text' } })).toThrow(
      /invalid function name/,
    );
  });

  it('rejects an unsafe EMITTED name (`sql`), which lands in the same raw slot', () => {
    // The four call-shaped exprs emit `${fn.sql ?? fn.name}(`, so guarding only
    // `name` left the identifier guarantee reachable around it.
    const r = createRegistry();
    expect(() =>
      r.registerFunction({
        name: 'safeName',
        shape: 'scalar',
        params: [],
        output: { kind: 'text' },
        sql: 'now(); DROP TABLE users; --',
      }),
    ).toThrow(/invalid function sql/);
    // A legitimate rename (the builtins' own use) still registers.
    expect(() =>
      r.registerFunction({ name: 'log10', shape: 'scalar', params: [], output: { kind: 'number' }, sql: 'log' }),
    ).not.toThrow();
  });

  it('rejects a run whose shape disagrees with the declared def', () => {
    const r = createRegistry();
    r.registerFunction({ name: 'myFn', shape: 'scalar', params: [], output: { kind: 'text' } });
    expect(() => r.registerFunctionRun('myFn', { shape: 'aggregate', run: () => ({} as never) })).toThrow(
      /declared 'scalar' but its run is 'aggregate'/,
    );
  });
});

describe('Registry unknown-kind parse throws', () => {
  const r = createRegistry();
  it('parseExpr / parseQuery reject unknown kinds', () => {
    // @ts-expect-error deliberately invalid kind
    expect(() => r.parseExpr({ kind: 'nope' })).toThrow(/unknown expr kind/);
    // @ts-expect-error deliberately invalid kind
    expect(() => r.parseQuery({ kind: 'nope' })).toThrow(/unknown query kind/);
  });
});

describe('Registry.finalize inverse-relation edges', () => {
  it('skips a relation whose target Type is not registered', () => {
    const r = createRegistry();
    const orphan: TypeDef = {
      name: 'orphan',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        // relation to an UNREGISTERED target with an inverseRelation
        { name: 'ghostId', type: { kind: 'relation', to: 'ghost', count: 1, inverseRelation: 'orphans' } },
      ],
      count: 10,
      bytes: 8,
    };
    r.registerType(r.parseType(orphan));
    expect(() => r.finalize()).not.toThrow();
    // No inverse materialized on a missing target (nothing to assert beyond no-throw).
    expect(r.type('ghost')).toBeUndefined();
  });

  it('materializes an inverse only once when two sources share the same name', () => {
    const r = createRegistry();
    const target: TypeDef = {
      name: 'hub',
      fields: [{ name: 'id', type: { kind: 'number', whole: true } }],
      indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'hub', field: 'id' }, count: 1 }] }],
      count: 5,
      bytes: 8,
    };
    const a: TypeDef = {
      name: 'a',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'hubId', type: { kind: 'relation', to: 'hub', count: 1, inverseRelation: 'items' } },
      ],
      count: 20,
      bytes: 8,
    };
    const b: TypeDef = {
      name: 'b',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'hubId', type: { kind: 'relation', to: 'hub', count: 1, inverseRelation: 'items' } },
      ],
      count: 30,
      bytes: 8,
    };
    r.registerType(r.parseType(target));
    r.registerType(r.parseType(a));
    r.registerType(r.parseType(b));
    r.finalize();
    const hub = r.type('hub')!;
    expect(hub.fields.filter((f) => f.name === 'items').length).toBe(1);
  });
});
