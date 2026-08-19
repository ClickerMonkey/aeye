/**
 * "Did you mean?" suggestions across EVERY unknown-name diagnostic.
 *
 * `didYouMean` (src/aids.ts) is unit-tested in `aids.test.ts`; here we assert
 * that each `validateWalk` / schema site that reports an unknown NAME appends the
 * nearest valid name for a genuine typo — and appends NOTHING for a far-off word
 * (no false positives). Sites are grouped by candidate kind: field, source, Type,
 * relation, function, named-arg, output, plus the schema enum layer.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { fixture, typeScope, runtimeFixture, lit, ref } from './_utils';
import { EXCLUDED_SOURCE } from '../exprs/excluded';
import { buildQueryTool, QueryToolError } from '../llm/tool';
import type { Context } from '@aeye/core';
import { Problems } from '../problem';
import type { ExprDef, InsertDef, UpdateDef, DeleteDef, SelectDef, TypeDef, FunctionDef } from '../schema';

/** The message of the first problem with `code` (or '' when none). */
function msg(p: Problems, code: string): string {
  return p.list.find((x) => x.code === code)?.message ?? '';
}

// ─── Field candidates (the resolved Type's field names) ───────────────────────

describe('unknown-field → nearest field name', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('field-ref suggests a near field and stays silent on a far one', () => {
    expect(msg(fx.engine.validateExpr(ref('u', 'nam'), scope), 'ref.unknown-field')).toContain(
      'did you mean `name`',
    );
    expect(msg(fx.engine.validateExpr(ref('u', 'zzzzzz'), scope), 'ref.unknown-field')).not.toContain(
      'did you mean',
    );
  });

  it('filters suggests the near field', () => {
    const p = fx.engine.validateExpr({ kind: 'filters', source: 'u', fields: ['nam'] }, scope);
    expect(msg(p, 'filters.unknown-field')).toContain('did you mean `name`');
  });

  it('semantic (field + pairing query field) suggests the near field', () => {
    expect(
      msg(fx.engine.validateExpr({ kind: 'semantic', source: 'u', field: 'emai', query: 'x' }, scope), 'semantic.unknown-field'),
    ).toContain('did you mean `email`');
    expect(
      msg(
        fx.engine.validateExpr({ kind: 'semantic', source: 'u', query: { type: 'user', field: 'emai' } } as ExprDef, scope),
        'semantic.unknown-query-field',
      ),
    ).toContain('did you mean `email`');
  });

  it('text-search / text-score suggest the near field', () => {
    expect(
      msg(fx.engine.validateExpr({ kind: 'text-search', source: 'u', field: 'emai', query: 'x' }, scope), 'text-search.unknown-field'),
    ).toContain('did you mean `email`');
    expect(
      msg(fx.engine.validateExpr({ kind: 'text-score', source: 'u', field: 'emai', query: 'x' }, scope), 'text-score.unknown-field'),
    ).toContain('did you mean `email`');
  });

  it('excluded suggests the near field of the conflict target', () => {
    const s = fx.engine.globalScope();
    s.bind(EXCLUDED_SOURCE, { kind: 'type', type: fx.user, source: EXCLUDED_SOURCE, synthetic: false });
    expect(msg(fx.engine.validateExpr({ kind: 'excluded', field: 'nam' }, s), 'excluded.unknown-field')).toContain(
      'did you mean `name`',
    );
  });

  it('insert (fields list + ON CONFLICT update) and update suggest the near field', () => {
    const rfx = runtimeFixture();
    const badFields: InsertDef = {
      kind: 'insert',
      into: 'user',
      rows: [{ nam: lit('x') }],
    };
    expect(msg(rfx.engine.validateQuery(badFields), 'insert.unknown-field')).toContain('did you mean `name`');

    const badConflict: InsertDef = {
      kind: 'insert',
      into: 'user',
      rows: [{ id: lit(1) }],
      onConflict: { fields: ['id'], update: { nam: lit('x') } },
    };
    expect(msg(rfx.engine.validateQuery(badConflict), 'insert.unknown-field')).toContain('did you mean `name`');

    const badUpdate: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: { nam: lit('x') },
    };
    expect(msg(rfx.engine.validateQuery(badUpdate), 'update.unknown-field')).toContain('did you mean `name`');
  });
});

// ─── Source candidates (bound source names in scope) ──────────────────────────

describe('unknown-source → nearest bound source name', () => {
  const fx = fixture();
  const scope = typeScope(fx); // binds `u` (user) and `o` (order)

  it('every source-bearing expr suggests the near source; a far one stays silent', () => {
    expect(msg(fx.engine.validateExpr(ref('uu', 'x'), scope), 'ref.unknown-source')).toContain('did you mean `u`');
    expect(msg(fx.engine.validateExpr(ref('zzzzz', 'x'), scope), 'ref.unknown-source')).not.toContain('did you mean');

    expect(msg(fx.engine.validateExpr({ kind: 'filters', source: 'uu' }, scope), 'filters.unknown-source')).toContain('did you mean `u`');
    // (`relation-path` is gone as a source-bearing expr — crossing a relation is
    // now a join, whose typo'd `on.source` reports `join.unresolved`; see the
    // dedicated relation-join block below.)
    expect(msg(fx.engine.validateExpr({ kind: 'semantic', source: 'uu', query: 'x' }, scope), 'semantic.unknown-source')).toContain('did you mean `u`');
    expect(msg(fx.engine.validateExpr({ kind: 'text-search', source: 'uu', query: 'x' }, scope), 'text-search.unknown-source')).toContain('did you mean `u`');
    expect(msg(fx.engine.validateExpr({ kind: 'text-score', source: 'uu', query: 'x' }, scope), 'text-score.unknown-source')).toContain('did you mean `u`');
  });

  it('REPORTS rather than THROWS when the unknown name is missing entirely', () => {
    // A pre-existing crash, fixed in `aids.ts`. Composing an unknown-NAME
    // diagnostic reads the bad name's `length` for the edit budget, and on the
    // unchecked `validateQuery` / `validateExpr` road that name can be absent
    // altogether — a raw `TypeError: Cannot read properties of undefined
    // (reading 'length')` came out of the suggester instead of a Problem, on the
    // one road whose entire contract is that a defect is REPORTED. The
    // structural parser refuses the same def first (asserted below), which is
    // why it was reachable only here.
    const noSource = { kind: 'text-search', query: 'x' } as unknown as ExprDef;
    expect(msg(fx.engine.validateExpr(noSource, scope), 'text-search.unknown-source')).toBe(
      "Unknown source 'undefined' for text search.",
    );
    const problems = new Problems();
    expect(fx.registry.parseCheckedExpr(noSource, problems)).toBeUndefined();
    expect(problems.hasErrors).toBe(true);
  });
});

// ─── Type candidates (registry type names) ────────────────────────────────────

describe('unknown-type → nearest registered Type name', () => {
  const rfx = runtimeFixture(); // registers `user` + `order`

  it('insert / update / delete suggest the near Type; a far one stays silent', () => {
    const ins: InsertDef = { kind: 'insert', into: 'usr', rows: [{ id: lit(1) }] };
    expect(msg(rfx.engine.validateQuery(ins), 'insert.unknown-type')).toContain('did you mean `user`');
    const insFar: InsertDef = { kind: 'insert', into: 'zzzzzz', rows: [{ id: lit(1) }] };
    expect(msg(rfx.engine.validateQuery(insFar), 'insert.unknown-type')).not.toContain('did you mean');

    const upd: UpdateDef = { kind: 'update', type: 'usr', set: { id: lit(1) } };
    expect(msg(rfx.engine.validateQuery(upd), 'update.unknown-type')).toContain('did you mean `user`');

    const del: DeleteDef = { kind: 'delete', from: 'usr' };
    expect(msg(rfx.engine.validateQuery(del), 'delete.unknown-type')).toContain('did you mean `user`');
  });

  it('a FROM source suggests the near Type / CTE name', () => {
    // An `aliased` source whose alias differs from the (typo'd) type name so the
    // unknown-type check fires (a bare `type` binds under its own name as a CTE).
    const sel: SelectDef = {
      kind: 'select',
      fields: [{ expr: lit(1), as: 'x' }],
      from: { kind: 'aliased', type: 'usr', as: 'u2' },
    };
    expect(msg(rfx.engine.validateQuery(sel), 'source.unknown-type')).toContain('did you mean `user`');
  });
});

// ─── Relation-segment candidates + relation-target Type ───────────────────────

describe('relation field-ref segment / target suggestions', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('a mistyped field suggests the near field name — relation OR scalar', () => {
    // Relation crossing is now a join, then a plain field-ref; a field-ref
    // suggests over ALL of the source's fields, so a mistyped RELATION field
    // name (`ordrs`) still surfaces the relation field `orders`…
    expect(
      msg(fx.engine.validateExpr(ref('u', 'ordrs'), scope), 'ref.unknown-field'),
    ).toContain('did you mean `orders`');
    // …and a mistyped scalar field (`not`) surfaces `note` on `order`.
    expect(
      msg(fx.engine.validateExpr(ref('o', 'not'), scope), 'ref.unknown-field'),
    ).toContain('did you mean `note`');
  });

  it('a relation join onto an unregistered target Type is flagged as unresolved', () => {
    // BEHAVIOR SHIFT: the old relation-path traversal suggested the near Type
    // name when a relation's `to` was unregistered (`relation-path.unknown-type`
    // + didYouMean). In the named-join model the crossing is a `relation` join;
    // an unresolvable target now reports `join.unresolved` (no target-type
    // suggestion — that didYouMean site no longer exists).
    const registry = createRegistry();
    const account: TypeDef = {
      name: 'account',
      fields: [{ name: 'id', type: { kind: 'number', whole: true } }],
      indexes: [{ exprs: [{ expr: ref('account', 'id'), count: 1 }] }],
      count: 1,
      bytes: 8,
    };
    const host: TypeDef = {
      name: 'host',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        // points at `acount` — a typo of the registered `account`.
        { name: 'acct', type: { kind: 'relation', to: 'acount', count: 1 } },
      ],
      indexes: [{ exprs: [{ expr: ref('host', 'id'), count: 1 }] }],
      count: 1,
      bytes: 8,
    };
    registry.registerType(registry.parseType(account));
    const hostType = registry.parseType(host);
    registry.registerType(hostType);
    registry.finalize();
    const engine = new QueryEngine(registry);
    const bad: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('h', 'id') }],
      from: { kind: 'aliased', type: 'host', as: 'h' },
      joins: [{ on: { kind: 'relation', source: 'h', field: 'acct', as: 'a' } }],
    };
    expect(msg(engine.validateQuery(bad), 'join.unresolved')).toContain("does not resolve to a relation");
  });
});

// ─── Function candidates (registry names of the matching shape) ───────────────

describe('unknown function → nearest function name of that shape', () => {
  function fnFixture() {
    const fx = fixture();
    const tabular: FunctionDef = { name: 'listRows', shape: 'tabular', params: [], output: { type: 'order' } };
    fx.registry.registerFunction(tabular);
    return fx;
  }
  const fx = fnFixture();
  const scope = typeScope(fx);

  it('scalar / aggregate / window / tabular each suggest a near name', () => {
    // scalar `length` (transposition typo)
    expect(
      msg(fx.engine.validateExpr({ kind: 'function-call', function: 'lenght', args: { value: ref('u', 'name') } }, scope), 'function.unknown'),
    ).toContain('did you mean `length`');
    // aggregate `sum`
    expect(
      msg(fx.engine.validateExpr({ kind: 'aggregate', function: 'summ', args: { value: ref('o', 'total') } }, scope), 'aggregate.unknown'),
    ).toContain('did you mean `sum`');
    // window `rank`
    expect(
      msg(fx.engine.validateExpr({ kind: 'window', function: 'rankk', args: {} }, scope), 'window.unknown'),
    ).toContain('did you mean `rank`');
    // tabular `listRows`
    expect(
      msg(fx.engine.validateExpr({ kind: 'tabular-function-call', function: 'listRow', args: {} }, scope), 'tabular-function.unknown'),
    ).toContain('did you mean `listRows`');
  });

  it('a far-off function name gets no suggestion', () => {
    expect(
      msg(fx.engine.validateExpr({ kind: 'function-call', function: 'zzzzzzzz', args: {} }, scope), 'function.unknown'),
    ).not.toContain('did you mean');
  });
});

// ─── Named-arg candidates (the function's declared param names) ────────────────

describe('unknown named-arg → nearest parameter name', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('suggests the near parameter of the called function', () => {
    // `replace(value, search, replacement)` — `serch` is a typo of `search`.
    const call: ExprDef = {
      kind: 'function-call',
      function: 'replace',
      args: { value: ref('u', 'name'), serch: lit('a'), replacement: lit('b') },
    };
    expect(msg(fx.engine.validateExpr(call, scope), 'function.unknown-arg')).toContain('did you mean `search`');
  });
});

// ─── Output-name candidates (the SELECT's output field names) ──────────────────

describe('unknown output ref → nearest output field name', () => {
  const rfx = runtimeFixture();

  it('a groupBy output reference suggests the near output name', () => {
    const sel: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('user', 'name'), as: 'name' },
        { expr: ref('user', 'age'), as: 'age' },
      ],
      from: { kind: 'type', type: 'user' },
      groupBy: [{ kind: 'output', name: 'nam' }],
    };
    expect(msg(rfx.engine.validateQuery(sel), 'output.unknown')).toContain('did you mean `name`');
  });
});

// ─── Schema enum layer (directed message via the parse tool) ───────────────────

describe('schema enum failure → nearest allowed value', () => {
  const emptyCtx: Context<{}, {}> = {};

  it('a near-miss comparison operator suggests the canonical spelling', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      fields: [{ expr: ref('user', 'id') }],
      // `notlike` is a case typo of the allowed `notLike` operator.
      where: [{ kind: 'comparison', op: 'notlike', left: ref('user', 'name'), right: ref('user', 'name') }],
    };
    let err: QueryToolError | undefined;
    try {
      await tool.parse(emptyCtx, JSON.stringify({ query: bad }));
    } catch (e) {
      if (e instanceof QueryToolError) err = e;
      else throw e;
    }
    expect(err).toBeDefined();
    const opMsg = err!.problems.list.find((p) => p.message.includes('comparison operator'))?.message ?? '';
    expect(opMsg).toContain('did you mean `notLike`');
  });
});
