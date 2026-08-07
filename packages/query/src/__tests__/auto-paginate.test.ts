/**
 * autoPaginate — binds `limit` / `offset` to named params when absent, leaves
 * already-present bounds untouched, and is idempotent. Also covers A16: WHICH
 * query kinds it pages (select / set operations / a `cte`'s `final`) and how it
 * refuses the kinds that have no row bound, instead of silently writing
 * `limit` / `offset` keys onto a statement that has no such fields.
 */
import { describe, it, expect } from 'vitest';
import { autoPaginate, canAutoPaginate } from '../transforms/index';
import type { PaginatableDef, PaginatableQuery } from '../transforms/index';
import { QueryTypeError } from '../problem';
import { CTEStatementQuery, SelectQuery, SetOperationQuery } from '../queries/index';
import { fixture } from './_utils';
import type {
  CTEStatementDef,
  ParamExprDef,
  QueryDef,
  SelectDef,
  SetOperationDef,
} from '../schema';

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

// ─── A16: what `autoPaginate` accepts, and how it refuses the rest ───────────

/**
 * `autoPaginate` used to be typed `SelectDef`-only while its JSON branch simply
 * spread whatever it was given and set `limit` / `offset` on the copy. Handed a
 * `CTEStatementDef` (via the `QueryDef` union or a cast) it produced a statement
 * carrying two keys the parser does not accept — SILENTLY. It is now defined on
 * exactly the kinds that HAVE a row bound, and refuses the others out loud.
 */

/** A minimal set operation over two selects (differing arms are irrelevant here). */
function baseSetOp(): SetOperationDef {
  return { kind: 'union', left: baseSelect(), right: baseSelect() };
}

/** A `WITH` statement whose `final` is a plain select. */
function baseCte(): CTEStatementDef {
  return {
    kind: 'cte',
    ctes: [{ name: 'c', query: baseSelect() }],
    final: {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'c', field: 'id' } }],
      from: { kind: 'type', type: 'c' },
    },
  };
}

describe('autoPaginate — set operations (A16)', () => {
  it('binds the SET-LEVEL bounds, leaving both arms untouched', () => {
    const input = baseSetOp();
    const out = autoPaginate(input);
    expect(isParam(out.limit, 'limit')).toBe(true);
    expect(isParam(out.offset, 'offset')).toBe(true);
    // Paging an ARM would change which rows the set operation compares.
    expect(out.left).toEqual(input.left);
    expect(out.right).toEqual(input.right);
  });

  it('emits the bounds as SET-LEVEL LIMIT / OFFSET, after the arms', () => {
    const fx = fixture();
    const { sql } = fx.engine.toSQL(autoPaginate(baseSetOp()), 'base', {
      params: { limit: 10, offset: 5 },
    });
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('OFFSET');
    expect(sql.indexOf('LIMIT')).toBeGreaterThan(sql.indexOf('UNION'));
  });

  it('is idempotent and non-mutating on a set operation', () => {
    const input = baseSetOp();
    const once = autoPaginate(input);
    expect(autoPaginate(once)).toEqual(once);
    expect(input.limit).toBeUndefined();
  });

  it('pages a parsed SetOperationQuery instance too', () => {
    const fx = fixture();
    const parsed = fx.engine.toQuery(baseSetOp());
    expect(parsed).toBeInstanceOf(SetOperationQuery);
    const out = autoPaginate(parsed as SetOperationQuery);
    expect(out).toBeInstanceOf(SetOperationQuery);
    expect(isParam(out.limit, 'limit')).toBe(true);
    // The input instance is untouched.
    expect((parsed as SetOperationQuery).limit).toBeUndefined();
  });
});

describe('autoPaginate — CTE statements (A16)', () => {
  it('pages the FINAL query, never the statement itself or a CTE body', () => {
    const input = baseCte();
    const out = autoPaginate(input);
    // The statement carries NO bounds of its own — `limit` / `offset` are not
    // `CTEStatementDef` keys, and writing them there is what used to be silent.
    expect('limit' in out).toBe(false);
    expect('offset' in out).toBe(false);
    const final = out.final as SelectDef;
    expect(isParam(final.limit, 'limit')).toBe(true);
    expect(isParam(final.offset, 'offset')).toBe(true);
    // The CTE bodies are intermediate results — never paged.
    expect(out.ctes).toEqual(input.ctes);
  });

  it('produces a statement the parser accepts and SQL that pages (the old bug)', () => {
    const fx = fixture();
    const paged = autoPaginate(baseCte());
    const { sql } = fx.engine.toSQL(paged, 'base', { params: { limit: 10, offset: 5 } });
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('OFFSET');
    // The bound sits on the final body, after the WITH list.
    expect(sql.indexOf('LIMIT')).toBeGreaterThan(sql.indexOf(')'));
  });

  it('pages a parsed CTEStatementQuery instance too', () => {
    const fx = fixture();
    const parsed = fx.engine.toQuery(baseCte()) as CTEStatementQuery;
    const out = autoPaginate(parsed);
    expect(out).toBeInstanceOf(CTEStatementQuery);
    expect(isParam((out.final as SelectQuery).limit, 'limit')).toBe(true);
    expect((parsed.final as SelectQuery).limit).toBeUndefined();
  });

  it('refuses a CTE whose final has no row bound', () => {
    const cte: CTEStatementDef = {
      kind: 'cte',
      ctes: [{ name: 'c', query: baseSelect() }],
      final: { kind: 'delete', from: 'order' } as QueryDef,
    };
    expect(() => autoPaginate(cte)).toThrow(/paginate\.unsupported-kind/);
  });
});

describe('autoPaginate — the refusal channel (A16)', () => {
  /** Every kind with no row bound to bind. */
  const unpaginatable: ReadonlyArray<{ name: string; def: QueryDef }> = [
    { name: 'insert', def: { kind: 'insert', into: 'order', values: [{}] } as QueryDef },
    { name: 'update', def: { kind: 'update', target: 'order', set: {} } as QueryDef },
    { name: 'delete', def: { kind: 'delete', from: 'order' } as QueryDef },
    { name: 'expr', def: { kind: 'expr', expr: { kind: 'literal', value: 1 } } as QueryDef },
  ];

  for (const { name, def } of unpaginatable) {
    it(`throws paginate.unsupported-kind for a '${name}' def instead of writing invalid keys`, () => {
      expect(() => autoPaginate(def as PaginatableDef)).toThrow(QueryTypeError);
      expect(() => autoPaginate(def as PaginatableDef)).toThrow(/paginate\.unsupported-kind/);
      // ...and the name of the offending kind is in the message.
      expect(() => autoPaginate(def as PaginatableDef)).toThrow(new RegExp(`'${name}'`));
    });

    it(`throws for a parsed '${name}' Query instance too`, () => {
      const parsed = fixture().engine.toQuery(def);
      expect(() => autoPaginate(parsed as PaginatableQuery)).toThrow(/paginate\.unsupported-kind/);
    });
  }

  it('canAutoPaginate answers for defs and parsed queries alike', () => {
    const fx = fixture();
    for (const def of [baseSelect(), baseSetOp(), baseCte()] as QueryDef[]) {
      expect(canAutoPaginate(def)).toBe(true);
      expect(canAutoPaginate(fx.engine.toQuery(def))).toBe(true);
    }
    for (const { def } of unpaginatable) {
      expect(canAutoPaginate(def)).toBe(false);
      expect(canAutoPaginate(fx.engine.toQuery(def))).toBe(false);
    }
  });
});
