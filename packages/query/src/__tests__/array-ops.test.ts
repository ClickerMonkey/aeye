/**
 * ArrayOpExpr + the array filter ops: resolution, validation, in-memory
 * evaluation, the length filter ops, and golden SQL (postgres-native vs the
 * base-dialect degrade).
 */
import { describe, it, expect } from 'vitest';
import { fixture, typeScope, runtimeFixture, ref, lit } from './_utils';
import { catalogForFieldType, compileFilters } from '../filters';
import type { ArrayOp, ExprDef, QueryDef, SelectDef } from '../schema';

/** Build an `array-op` ExprDef (no cast — `op` is typed as `ArrayOp`). */
const arrayOp = (op: ArrayOp, target: ExprDef, value?: ExprDef | ExprDef[]): ExprDef =>
  value === undefined
    ? { kind: 'array-op', op, target }
    : { kind: 'array-op', op, target, value };

describe('array-op: resolution', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('resolves to a boolean computed type', () => {
    const r = fx.engine.resolveExpr(arrayOp('contains', ref('u', 'tags'), lit('x')), scope);
    expect(r.kind).toBe('computed');
    if (r.kind === 'computed') expect(r.fieldType.resolve()).toBe('bool');
  });
});

describe('array-op: validation', () => {
  const fx = fixture();
  const scope = typeScope(fx);
  const codes = (def: ExprDef): string[] => fx.engine.validateExpr(def, scope).list.map((p) => p.code);

  it('rejects a non-array target (array-op.not-array)', () => {
    expect(codes(arrayOp('contains', ref('u', 'name'), lit('x')))).toContain('array-op.not-array');
  });

  it('rejects an element type incompatible with the item type (array-op.type-mismatch)', () => {
    expect(codes(arrayOp('contains', ref('u', 'tags'), lit(5)))).toContain('array-op.type-mismatch');
  });

  it('rejects a bad operand arity (array-op.value-arity)', () => {
    // isEmpty takes no value.
    expect(codes(arrayOp('isEmpty', ref('u', 'tags'), lit('x')))).toContain('array-op.value-arity');
    // contains requires exactly one value.
    expect(codes(arrayOp('contains', ref('u', 'tags')))).toContain('array-op.value-arity');
  });

  it('accepts a well-formed clause', () => {
    expect(fx.engine.validateExpr(arrayOp('contains', ref('u', 'tags'), lit('admin')), scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(arrayOp('isEmpty', ref('u', 'tags')), scope).hasErrors).toBe(false);
  });
});

describe('array-op: in-memory evaluation', () => {
  // Ada tags=['admin','beta'], Bob tags=['beta'], Cleo tags=[].
  const names = async (where: ExprDef): Promise<string[]> => {
    const fx = runtimeFixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      where: [where],
    };
    const r = await fx.engine.run(def);
    return r.rows.map((row) => String(row['name'])).sort();
  };

  it('contains', async () => {
    expect(await names(arrayOp('contains', ref('user', 'tags'), lit('admin')))).toEqual(['Ada']);
    expect(await names(arrayOp('contains', ref('user', 'tags'), lit('beta')))).toEqual(['Ada', 'Bob']);
  });

  it('containsAny', async () => {
    expect(await names(arrayOp('containsAny', ref('user', 'tags'), [lit('admin'), lit('beta')]))).toEqual(['Ada', 'Bob']);
    expect(await names(arrayOp('containsAny', ref('user', 'tags'), [lit('nope')]))).toEqual([]);
  });

  it('containsAll', async () => {
    expect(await names(arrayOp('containsAll', ref('user', 'tags'), [lit('admin'), lit('beta')]))).toEqual(['Ada']);
    expect(await names(arrayOp('containsAll', ref('user', 'tags'), [lit('beta')]))).toEqual(['Ada', 'Bob']);
  });

  it('isEmpty / notEmpty', async () => {
    expect(await names(arrayOp('isEmpty', ref('user', 'tags')))).toEqual(['Cleo']);
    expect(await names(arrayOp('notEmpty', ref('user', 'tags')))).toEqual(['Ada', 'Bob']);
  });
});

describe('array filter ops: catalog compile + value schemas', () => {
  const fx = fixture();
  const arrayFt = fx.registry.parseFieldType({ kind: 'array', item: { kind: 'text' } });
  const ops = catalogForFieldType(arrayFt);
  const op = (name: string) => ops.find((o) => o.op === name)!;
  const field = fx.registry.parseExpr(ref('u', 'tags'));
  const val = (v: string | number) => fx.registry.parseExpr(lit(v));

  it('contains compiles to an array-op', () => {
    expect(op('contains').compile(field, [val('x')], fx.registry).toJSON()).toEqual({
      kind: 'array-op', op: 'contains', target: ref('u', 'tags'), value: lit('x'),
    });
  });

  it('containsAny compiles to an array-op with a value list', () => {
    expect(op('containsAny').compile(field, [val('a'), val('b')], fx.registry).toJSON()).toEqual({
      kind: 'array-op', op: 'containsAny', target: ref('u', 'tags'), value: [lit('a'), lit('b')],
    });
  });

  it('lengthGte compiles to a comparison over arrayLength(field)', () => {
    expect(op('lengthGte').compile(field, [val(2)], fx.registry).toJSON()).toEqual({
      kind: 'comparison',
      op: '>=',
      left: { kind: 'function-call', function: 'arrayLength', args: { arr: ref('u', 'tags') } },
      right: lit(2),
    });
  });

  it('value schemas match the operand shape', () => {
    expect(op('contains').valueSchema(arrayFt).safeParse('x').success).toBe(true);
    expect(op('contains').valueSchema(arrayFt).safeParse(5).success).toBe(false);
    expect(op('containsAny').valueSchema(arrayFt).safeParse(['a', 'b']).success).toBe(true);
    expect(op('lengthGte').valueSchema(arrayFt).safeParse(3).success).toBe(true);
    expect(op('lengthGte').valueSchema(arrayFt).safeParse('x').success).toBe(false);
    expect(op('isEmpty').valueSchema(arrayFt).safeParse(undefined).success).toBe(true);
  });
});

describe('array length filter ops: end-to-end run', () => {
  const names = async (op: string, value: number): Promise<string[]> => {
    const fx = runtimeFixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'filters', source: 'user' }],
    };
    const filter = compileFilters('user', [{ field: 'tags', op, value }], fx.registry);
    const r = await fx.engine.run(def, { filters: { user: filter } });
    return r.rows.map((row) => String(row['name'])).sort();
  };

  it('lengthGte / lengthEq filter by element count', async () => {
    // Ada=2, Bob=1, Cleo=0.
    expect(await names('lengthGte', 1)).toEqual(['Ada', 'Bob']);
    expect(await names('lengthEq', 2)).toEqual(['Ada']);
    expect(await names('lengthLt', 1)).toEqual(['Cleo']);
  });
});

describe('array-op: SQL emission (postgres-native vs base degrade)', () => {
  const fx = fixture();
  const select = (where: ExprDef): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('user', 'name'), as: 'name' }],
    from: { kind: 'type', type: 'user' },
    where: [where],
  });

  it('postgres contains → "= ANY"', () => {
    const out = fx.engine.toSQL(select(arrayOp('contains', ref('user', 'tags'), lit('admin'))), 'postgres');
    expect(out.sql).toContain('$1 = ANY("user"."tags")');
    expect(out.params).toEqual(['admin']);
  });

  it('postgres containsAll / containsAny → "@>" / "&&"', () => {
    const all = fx.engine.toSQL(select(arrayOp('containsAll', ref('user', 'tags'), [lit('a'), lit('b')])), 'postgres');
    expect(all.sql).toContain('"user"."tags" @> ARRAY[$1, $2]');
    const any = fx.engine.toSQL(select(arrayOp('containsAny', ref('user', 'tags'), [lit('a')])), 'postgres');
    expect(any.sql).toContain('"user"."tags" && ARRAY[$1]');
  });

  it('postgres array length filter → cardinality(...)', () => {
    const def: SelectDef = {
      ...select(arrayOp('isEmpty', ref('user', 'tags'))),
      where: [{ kind: 'filters', source: 'user' }],
    };
    const filter = compileFilters('user', [{ field: 'tags', op: 'lengthGte', value: 2 }], fx.registry);
    const out = fx.engine.toSQL(def, 'postgres', { filters: { user: filter } });
    expect(out.sql).toContain('cardinality("user"."tags") >= $1');
    expect(out.params).toEqual([2]);
  });

  it('base dialect: emptiness works via json_array_length', () => {
    const out = fx.engine.toSQL(select(arrayOp('isEmpty', ref('user', 'tags'))), 'base');
    expect(out.sql).toContain('COALESCE(json_array_length("user"."tags"), 0) = 0');
  });

  it('base dialect: containment throws a clear, documented error', () => {
    expect(() => fx.engine.toSQL(select(arrayOp('contains', ref('user', 'tags'), lit('admin'))), 'base')).toThrow(
      /unsupported in the base/i,
    );
  });
});
