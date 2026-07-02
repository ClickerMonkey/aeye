/**
 * Coverage: filter-op catalog per FieldType, each op's compile + valueSchema,
 * literalString / likePattern edges, clause value shaping, and compileFilters.
 */
import { describe, it, expect } from 'vitest';
import { fixture } from './_utils';
import {
  catalogForFieldType,
  filterOpByName,
  compileFilters,
  SIMILARITY_THRESHOLD,
} from '../filters';
import type { FilterOp } from '../filters';
import type { Registry } from '../registry';
import type { Expr } from '../expr';
import type { FieldType } from '../field-type';
import type { FilterClauseDef, FieldTypeDef } from '../schema';

const fx = fixture();
const registry: Registry = fx.registry;
const fieldRef = (): Expr => registry.parseExpr({ kind: 'field-ref', source: 'user', field: 'name' });
const lit = (v: unknown): Expr => registry.parseExpr({ kind: 'literal', value: v as never });

function valuesForArity(op: FilterOp): Expr[] {
  switch (op.arity) {
    case 'unary':
      return [];
    case 'binary':
      return [lit('x')];
    case 'list':
    case 'range':
      return [lit('a'), lit('b')];
  }
}

describe('catalogForFieldType covers every FieldType kind', () => {
  const kinds: FieldTypeDef[] = [
    { kind: 'number' },
    { kind: 'money', currency: 'USD' },
    { kind: 'date' },
    { kind: 'timestamp' },
    { kind: 'text' },
    { kind: 'text', search: true, semantic: true },
    { kind: 'bool' },
    { kind: 'relation', to: 'user', count: 1 },
    { kind: 'json' },
    { kind: 'array', item: { kind: 'text' } },
    { kind: 'array' }, // no item → arrayElementSchema fallback
  ];

  it('each op in each catalog compiles + schematizes without error', () => {
    for (const def of kinds) {
      const ft: FieldType = registry.parseFieldType(def);
      const ops = catalogForFieldType(ft);
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) {
        // valueSchema for the field type
        expect(op.valueSchema(ft)).toBeTruthy();
        // compile to a boolean expr (all catalog fields are field-refs)
        const compiled = op.compile(fieldRef(), valuesForArity(op), registry);
        expect(compiled.kind).toBeTruthy();
      }
    }
  });
});

describe('op edge branches', () => {
  it('pattern ops handle all three modes + empty/omitted operands', () => {
    for (const name of ['contains', 'startsWith', 'endsWith']) {
      const op = filterOpByName(name)!;
      // omitted value → literalString('') path
      expect(op.compile(fieldRef(), [], registry).kind).toBe('comparison');
    }
  });

  it('literalString ignores non-string literal values (hasKey with a number)', () => {
    const hasKey = filterOpByName('hasKey')!;
    const compiled = hasKey.compile(fieldRef(), [lit(42)], registry);
    expect(compiled.kind).toBe('comparison');
  });

  it('like / membership / null / between / arrayLength / anyMatch / pathEq compile', () => {
    expect(filterOpByName('like')!.compile(fieldRef(), [lit('%x%')], registry).kind).toBe('comparison');
    expect(filterOpByName('in')!.compile(fieldRef(), [lit('a'), lit('b')], registry).kind).toBe('in');
    expect(filterOpByName('isNull')!.compile(fieldRef(), [], registry).kind).toBe('is-null');
    expect(filterOpByName('between')!.compile(fieldRef(), [lit(1)], registry).kind).toBe('between'); // missing upper → null literal
    expect(filterOpByName('lengthEq')!.compile(fieldRef(), [lit(3)], registry).kind).toBe('comparison');
    expect(filterOpByName('anyMatch')!.compile(fieldRef(), [lit(1)], registry).kind).toBe('comparison');
    expect(filterOpByName('pathEq')!.compile(fieldRef(), [lit('a'), lit('b')], registry).kind).toBe('comparison');
    expect(filterOpByName('isEmpty')!.compile(fieldRef(), [], registry).kind).toBe('array-op');
  });

  it('search / similar require a field reference (else throw)', () => {
    const search = filterOpByName('search')!;
    const similar = filterOpByName('similar')!;
    expect(search.compile(fieldRef(), [lit('q')], registry).kind).toBe('text-search');
    expect(similar.compile(fieldRef(), [lit('q')], registry).kind).toBe('comparison');
    expect(() => search.compile(lit('notref'), [lit('q')], registry)).toThrow(/field reference/);
    expect(() => similar.compile(lit('notref'), [lit('q')], registry)).toThrow(/field reference/);
    expect(SIMILARITY_THRESHOLD).toBeGreaterThan(0);
  });

  it('unknown op name resolves to undefined', () => {
    expect(filterOpByName('nope')).toBeUndefined();
  });
});

describe('compileFilters', () => {
  it('handles zero / one / many clauses + every value arity', () => {
    expect(compileFilters('user', [], registry).kind).toBe('literal'); // vacuous TRUE
    const one: FilterClauseDef[] = [{ field: 'age', op: 'isNull' }]; // unary → []
    expect(compileFilters('user', one, registry).kind).toBe('is-null');
    const many: FilterClauseDef[] = [
      { field: 'age', op: 'eq', value: 5 }, // binary single value
      { field: 'age', op: 'in', value: [1, 2] }, // list array value
      { field: 'age', op: 'between', value: [1, 9] }, // range
      { field: 'name', op: 'eq' }, // binary, undefined value → []
    ];
    expect(compileFilters('user', many, registry).kind).toBe('logical');
  });

  it('throws for an unknown clause op', () => {
    expect(() => compileFilters('user', [{ field: 'age', op: 'nope' }], registry)).toThrow(/unknown filter op/);
  });
});
