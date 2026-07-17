/**
 * Coverage driver for the `output` reference expr:
 *   exprs/output-ref.ts, the QueryScope `outputs` binding, the RuntimeContext
 *   `withOutputs` / `outputExpr` threading, the SelectQuery wiring, the
 *   validation codes, the LLM schema position-gating, and the drill-down
 *   `output` expansion (`transforms/drill-down.ts`).
 *
 * Exercises every method / branch across BOTH dialects + the runtime: a group
 * key delegate on a source row, an ORDER BY / HAVING delegate over the group
 * (including an aggregate target), a ref nested inside another expr, the
 * `output.unknown` / `output.aggregate` / `output.not-available` problems, the
 * unbound fallbacks (resolve / cost / evaluate / toSQL), round-trip toJSON /
 * clone / canonicalize, the LLM schema offering it in groupBy / orderBy /
 * having while REJECTING it in WHERE / the general Expr union, and the
 * drill-down expansion of every wrapping expr kind.
 */
import { describe, it, expect } from 'vitest';
import { cctx, fixture, runtimeFixture, typeScope, ref, lit, cmp, param } from './_utils';
import { RuntimeContext } from '../runtime/context';
import { OutputRefExpr } from '../exprs/output-ref';
import { UnaryExpr } from '../exprs/unary';
import { canonicalize } from '../expr';
import { buildSchemas } from '../llm/schemas';
import { exprKindApplicable, selectFunctions } from '../schema-build';
import { drillDown } from '../transforms/drill-down';
import { JoinCtePlanner } from '../sql/planner';
import { SqlContext } from '../sql/emit';
import { asFieldType } from '../resolved-type';
import type { Expr } from '../expr';
import type { SelectDef, ExprDef } from '../schema';

const outRef = (name: string): ExprDef => ({ kind: 'output', name });

// ─── output-ref.ts — serialization / schema / static from ─────────────────────

describe('output-ref: serialization, schema, static from', () => {
  const fx = fixture();

  it('round-trips toJSON / clone / toCode / forEachChild / canonicalize', () => {
    const e = fx.engine.parse(outRef('revenue'));
    expect(e.toJSON()).toEqual({ kind: 'output', name: 'revenue' });
    expect(e.clone().toJSON()).toEqual({ kind: 'output', name: 'revenue' });
    expect(e.toCode()).toBe('output(revenue)');
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(0);
    // canonical digest is kind + name (equal for same name, differs otherwise).
    expect(canonicalize(e)).toBe(canonicalize(fx.engine.parse(outRef('revenue'))));
    expect(canonicalize(e)).not.toBe(canonicalize(fx.engine.parse(outRef('other'))));
  });

  it('static `from` rejects a mismatched kind', () => {
    expect(() => OutputRefExpr.from(lit(1), fx.registry)).toThrow(/expected 'output'/);
  });

  it('toSchema accepts a well-formed ref and rejects a missing name', () => {
    const schema = OutputRefExpr.toSchema({});
    expect(schema.safeParse({ kind: 'output', name: 'x' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'output' }).success).toBe(false);
  });
});

// ─── QueryScope: outputs binding accessors ────────────────────────────────────

describe('output-ref: QueryScope outputs accessors', () => {
  const fx = fixture();

  it('output / hasOutputs / outputNames reflect the bound outputs (local only)', () => {
    const s = fx.engine.globalScope();
    expect(s.hasOutputs()).toBe(false);
    expect(s.outputNames()).toEqual([]);
    expect(s.output('x')).toBeUndefined();

    const child = s.child().bindOutputs(new Map<string, Expr>([['a', fx.engine.parse(ref('o', 'total'))]]));
    expect(child.hasOutputs()).toBe(true);
    expect(child.outputNames()).toEqual(['a']);
    expect(child.output('a')).toBeDefined();
    expect(child.output('missing')).toBeUndefined();
  });
});

// ─── output-ref.ts — resolve / cost / unbound fallbacks ───────────────────────

describe('output-ref: resolve / cost delegation and unbound fallbacks', () => {
  const fx = fixture();

  it('resolve delegates to the bound target; unbound ⇒ nullable text placeholder', () => {
    const scope = typeScope(fx).child();
    const outputs = new Map<string, Expr>([['amount', fx.engine.parse(ref('o', 'total'))]]);
    scope.bindOutputs(outputs);
    const bound = fx.engine.parse(outRef('amount')).resolve(fx.engine, scope);
    expect(bound.kind).toBe('field');

    // No outputs bound at this scope ⇒ delegate target missing ⇒ placeholder.
    const unbound = fx.engine.resolveExpr(outRef('amount'), typeScope(fx));
    expect(unbound.kind).toBe('computed');
  });

  it('cost delegates to the target (else ZERO_COST when unbound)', () => {
    const scope = typeScope(fx).child();
    scope.bindOutputs(new Map<string, Expr>([['amount', fx.engine.parse(ref('o', 'total'))]]));
    const bound = fx.engine.parse(outRef('amount')).cost(cctx(fx.engine), scope);
    expect(bound.rows).toBe(0);
    expect(bound.bytes).toBeGreaterThanOrEqual(0);

    const unbound = fx.engine.parse(outRef('amount')).cost(cctx(fx.engine), typeScope(fx));
    expect(unbound).toEqual({ rows: 0, bytes: 0 });
  });
});

// ─── output-ref.ts — validation codes ─────────────────────────────────────────

describe('output-ref: validation codes', () => {
  const fx = fixture();

  // `uid` reads a SCALAR field: `order.userId` is a relation field, and a
  // field-ref to a relation is now a `ref.relation` error, so the group key
  // reads `order.id` (the "valid groupBy over outputs" case must stay clean).
  const base = (extra: Partial<SelectDef>): SelectDef => ({
    kind: 'select',
    fields: [
      { expr: ref('order', 'id'), as: 'uid' },
      { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
    ],
    from: { kind: 'type', type: 'order' },
    ...extra,
  });

  it('output.not-available when used in WHERE (no outputs bound there)', () => {
    const p = fx.engine.validateQuery(base({ where: [cmp('>', outRef('cnt'), lit(0))] }));
    expect(p.list.some((x) => x.code === 'output.not-available')).toBe(true);
  });

  it('output.unknown when the name is not a SELECT output field', () => {
    const p = fx.engine.validateQuery(base({ groupBy: [outRef('nope')] }));
    const prob = p.list.find((x) => x.code === 'output.unknown');
    expect(prob).toBeDefined();
    expect(prob!.message).toContain('uid');
  });

  it('output.aggregate when a GROUP BY key references an aggregate output', () => {
    const p = fx.engine.validateQuery(base({ groupBy: [outRef('cnt')] }));
    expect(p.list.some((x) => x.code === 'output.aggregate')).toBe(true);
  });

  it('a valid groupBy / having / order over outputs has no errors', () => {
    const p = fx.engine.validateQuery(
      base({
        groupBy: [outRef('uid')],
        having: [cmp('>', outRef('cnt'), lit(1))],
        order: [{ expr: outRef('cnt'), dir: 'desc' }],
      }),
    );
    expect(p.hasErrors).toBe(false);
  });
});

// ─── output-ref.ts — runtime evaluate (both delegate directions) ──────────────

describe('output-ref: runtime evaluate', () => {
  it('delegates a group key on the source row and an ORDER/HAVING ref over the group', async () => {
    const rfx = runtimeFixture();
    // GROUP BY output(uid) (source-row delegate), HAVING output(cnt) > 1 and
    // ORDER BY output(cnt) DESC (aggregate delegate over the group).
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'uid' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('uid')],
      having: [cmp('>', outRef('cnt'), lit(1))],
      order: [{ expr: outRef('cnt'), dir: 'desc' }],
    };
    const rows = (await rfx.engine.run(def)).rows;
    // userId 1 and 2 each have 2 orders (cnt 2 > 1); userId 3 (Cleo) has none.
    expect(rows).toEqual([{ uid: 1, cnt: 2 }, { uid: 2, cnt: 2 }]);
  });

  it('delegates when the ref is NESTED inside another expr in ORDER BY', async () => {
    const rfx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'uid' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('uid')],
      // ORDER BY (output(revenue) + 0) ASC — the ref is nested in a binary.
      order: [{ expr: { kind: 'binary', op: '+', left: outRef('revenue'), right: lit(0) }, dir: 'asc' }],
    };
    const rows = (await rfx.engine.run(def)).rows;
    // userId 1 revenue 150, userId 2 revenue 225 ⇒ ascending by revenue.
    expect(rows.map((r) => r['uid'])).toEqual([1, 2]);
  });

  it('evaluate ⇒ NULL when no outputs are installed on the context', async () => {
    const rfx = runtimeFixture();
    const ctx = new RuntimeContext(rfx.engine);
    expect((await rfx.engine.parse(outRef('x')).evaluate(ctx, null)).isNull()).toBe(true);
    expect((await rfx.engine.parse(outRef('x')).evaluate(ctx, { order: { id: 1 } })).isNull()).toBe(true);
  });
});

// ─── output-ref.ts — SQL emission (both dialects) + unbound NULL ──────────────

describe('output-ref: SQL emission', () => {
  const fx = fixture();

  it('EXPANDS to the target SQL in groupBy / having / order (base + postgres)', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'uid' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('uid')],
      having: [cmp('>', outRef('cnt'), lit(1))],
      order: [{ expr: outRef('cnt'), dir: 'desc' }],
    };
    for (const dialect of ['base', 'postgres'] as const) {
      const { sql } = fx.engine.toSQL(def, dialect);
      // The output refs expanded — no literal `output` marker leaks into SQL.
      expect(sql).not.toContain('output');
      // GROUP BY expands to the underlying column; HAVING / ORDER to COUNT(*).
      expect(sql).toContain('GROUP BY "order"."userId"');
      expect(sql.toUpperCase()).toContain('HAVING COUNT(*) >');
      expect(sql.toUpperCase()).toContain('ORDER BY COUNT(*) DESC');
    }
  });

  it('toSQL ⇒ NULL when the reference is unbound in the scope', () => {
    const dialect = fx.registry.dialect('base');
    if (!dialect) throw new Error('base dialect missing');
    const planner = new JoinCtePlanner(dialect, fx.engine, undefined);
    const ctx = new SqlContext(dialect, fx.engine, fx.engine.globalScope(), planner, undefined);
    const sql = fx.engine.parse(outRef('x')).toSQL(dialect, ctx).render(dialect).sql;
    expect(sql).toBe('NULL');
  });
});

// ─── LLM schema: position-gated offering ──────────────────────────────────────

describe('output-ref: LLM schema position gating', () => {
  const fx = fixture();
  const schemas = buildSchemas(fx.engine);
  const sel = (extra: Record<string, unknown>): Record<string, unknown> => ({
    kind: 'select',
    fields: [{ expr: ref('user', 'name'), as: 'name' }],
    from: { kind: 'type', type: 'user' },
    ...extra,
  });

  it('offers `output` in groupBy / orderBy / having', () => {
    expect(schemas.Select.safeParse(sel({ groupBy: [outRef('name')] })).success).toBe(true);
    expect(schemas.Select.safeParse(sel({ having: [outRef('name')] })).success).toBe(true);
    expect(schemas.Select.safeParse(sel({ order: [{ expr: outRef('name'), dir: 'asc' }] })).success).toBe(true);
  });

  it('does NOT offer `output` in WHERE or the general Expr union', () => {
    expect(schemas.Expr.safeParse(outRef('name')).success).toBe(false);
    expect(schemas.Select.safeParse(sel({ where: [outRef('name')] })).success).toBe(false);
  });

  it('exprKindApplicable gates `output` out of the general union', () => {
    expect(exprKindApplicable('output', fx.registry.typeList(), selectFunctions(fx.registry))).toBe(false);
  });
});

// ─── drill-down: output expansion ─────────────────────────────────────────────

describe('output-ref: drill-down expansion', () => {
  const fx = fixture();

  it('expands group-key + order output refs against the original items', () => {
    const revenue: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'userId' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('userId')],
      order: [{ expr: outRef('userId'), dir: 'asc' }],
    };
    const d = drillDown(revenue, fx.engine);
    expect('query' in d).toBe(true);
    if ('query' in d) {
      // The rebuilt query has no dangling `output` reference.
      expect(JSON.stringify(d.query.toJSON())).not.toContain('"kind":"output"');
      expect(d.params[0]!.field).toBe('userId');
      expect(d.params[0]!.key).toEqual({ kind: 'field-ref', source: 'order', field: 'userId' });
    }
  });

  it('expands an aggregate-referencing HAVING output ref ⇒ drill.having-aggregate', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'userId' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('userId')],
      having: [cmp('>', outRef('revenue'), lit(0))],
    };
    const d = drillDown(def, fx.engine);
    expect('error' in d).toBe(true);
    if ('error' in d) expect(d.error.list.some((p) => p.code === 'drill.having-aggregate')).toBe(true);
  });

  it('UN-AGGREGATES an ORDER-only aggregate to its underlying field when drilling a bare aggregate', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' }],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: outRef('revenue'), dir: 'desc' }],
    };
    const d = drillDown(def, fx.engine);
    // A bare aggregate un-ravels; ORDER `output('revenue')` expands to sum(total),
    // which UN-AGGREGATES to the `total` field — kept, not dropped.
    expect('query' in d).toBe(true);
    if ('query' in d) {
      const json = JSON.stringify(d.query.toJSON());
      expect(json).not.toContain('"kind":"output"');
      expect(json).toContain('"field":"total"');
      expect(d.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(false);
    }
  });

  it('recurses through EVERY wrapping expr kind when expanding outputs', () => {
    // A GROUP BY output ref triggers expansion; the HAVING / ORDER clauses embed
    // one of every wrapping expr kind so `expandOutputDef` walks each arm. (The
    // drill itself errors on the aggregate HAVING — expansion runs regardless.)
    const havingOperands: ExprDef[] = [
      cmp('>', ref('order', 'total'), lit(0)), // comparison
      { kind: 'binary', op: '+', left: ref('order', 'total'), right: lit(1) }, // binary
      { kind: 'unary', op: '-', operand: ref('order', 'total') }, // unary
      { kind: 'between', value: ref('order', 'total'), lower: lit(0), upper: lit(9) }, // between
      { kind: 'in', value: ref('order', 'userId'), in: [lit(1), lit(2)] }, // in (list)
      { kind: 'in', value: ref('order', 'userId'), in: { kind: 'select', fields: [{ expr: ref('order', 'userId') }], from: { kind: 'type', type: 'order' } } }, // in (subquery)
      { kind: 'is-null', value: ref('order', 'note') }, // is-null
      { kind: 'array-op', op: 'contains', target: ref('order', 'note'), value: lit('x') }, // array-op single
      { kind: 'array-op', op: 'containsAny', target: ref('order', 'note'), value: [lit('x')] }, // array-op list
      { kind: 'array-op', op: 'isEmpty', target: ref('order', 'note') }, // array-op none
      { kind: 'case', branches: [{ when: cmp('>', ref('order', 'total'), lit(0)), then: lit(1) }], else: lit(0) }, // case (else)
      { kind: 'case', branches: [{ when: cmp('>', ref('order', 'total'), lit(0)), then: lit(1) }] }, // case (no else)
      { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, // aggregate
      { kind: 'function-call', function: 'upper', args: { value: ref('order', 'note') } }, // function-call
      { kind: 'tabular-function-call', function: 'gen', args: {} }, // tabular-function-call
      // leaves (all share one arm):
      { kind: 'subquery', query: { kind: 'select', fields: [{ expr: ref('order', 'id') }], from: { kind: 'type', type: 'order' } } },
      { kind: 'param', name: 'p' },
      // (`relation-path` removed — crossing a relation is now a named join, not a leaf expr.)
      { kind: 'semantic', source: 'order', query: 'x' },
      { kind: 'text-search', source: 'order', query: 'x' },
      { kind: 'filters', source: 'order' },
      { kind: 'excluded', field: 'note' },
      // A (structurally-nested) sorter exercises `expandOutputDef`'s `sorter`
      // arm — its catalog exprs are expanded like any other child position.
      { kind: 'sorter', sorts: { byTotal: ref('order', 'total') } },
      ref('order', 'id'),
      lit(true),
    ];
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'uid' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('uid')],
      having: [{ kind: 'logical', op: 'and', operands: havingOperands }],
      order: [
        { expr: { kind: 'window', function: 'rowNumber', args: {}, partitionBy: [ref('order', 'userId')], orderBy: [{ expr: ref('order', 'total'), dir: 'asc' }] }, dir: 'asc' }, // window (optionals)
        { expr: { kind: 'window', function: 'rowNumber', args: {} }, dir: 'asc' }, // window (no optionals)
      ],
    };
    const d = drillDown(def, fx.engine);
    // The expansion ran (no `output` marker survives in the returned defs). The
    // drill errors on the aggregate HAVING; either way expansion is complete.
    expect(typeof d).toBe('object');
  });

  it('leaves an UNKNOWN output ref unchanged during expansion', () => {
    // One valid output ref triggers expansion; an unknown-named one exercises the
    // `outputs.get(name) ?? def` fallback (the ref stays, to be flagged later).
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' }],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('revenue')],
      order: [{ expr: outRef('missing'), dir: 'asc' }],
    };
    const d = drillDown(def, fx.engine);
    expect(typeof d).toBe('object');
  });
});

// ─── unary.ts — full in-file coverage ─────────────────────────────────────────
//
// The drill-down "every wrapping kind" test above PARTIALLY parses `unary`.
// vitest's v8 coverage reporter mis-merges a module that one test file covers
// only partially while exactly one OTHER file covers it fully, so this block
// exercises `unary.ts` end-to-end here too, keeping this file's contribution at
// 100% regardless of the merge.
describe('output-ref: full unary.ts coverage (v8 merge workaround)', () => {
  const fx = fixture();
  const scope = typeScope(fx);
  const un = (op: '-' | '+', operand: ExprDef): ExprDef => ({ kind: 'unary', op, operand });

  it('from / toSchema / forEachChild / cost / serialization', () => {
    expect(() => UnaryExpr.from(lit(1), fx.registry)).toThrow(/expected 'unary'/);
    expect(UnaryExpr.toSchema({}).safeParse({ kind: 'unary', op: '-', operand: { kind: 'literal', value: 1 } }).success).toBe(true);
    const e = fx.engine.parse(un('-', ref('o', 'total')));
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(1);
    expect(e.cost(cctx(fx.engine), scope).rows).toBe(0);
    expect(e.toJSON()).toEqual({ kind: 'unary', op: '-', operand: { kind: 'field-ref', source: 'o', field: 'total' } });
    expect(e.clone().toJSON()).toEqual(e.toJSON());
    expect(e.toCode()).toBe('-o.total');
  });

  it('resolve mirrors money vs number operand category', () => {
    expect(asFieldType(fx.engine.resolveExpr(un('-', ref('o', 'total')), scope))?.resolve()).toBe('money');
    expect(asFieldType(fx.engine.resolveExpr(un('+', ref('u', 'age')), scope))?.resolve()).toBe('number');
  });

  it('validateWalk: numeric ok / type error / null-literal + param exempt', () => {
    expect(fx.engine.validateExpr(un('-', ref('o', 'total')), scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(un('+', ref('u', 'age')), scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(un('-', ref('u', 'name')), scope).list.some((p) => p.code === 'unary.type')).toBe(true);
    // Operand resolving to a Type ⇒ categoryOf is undefined ⇒ the `cat ?? 'a type'`
    // message branch. A tabular-function-call is the remaining Type-resolving expr.
    const typeOperand: ExprDef = { kind: 'tabular-function-call', function: 'gen', args: {} };
    expect(
      fx.engine.validateExpr(un('-', typeOperand), scope).list.some((p) => p.code === 'unary.type'),
    ).toBe(true);
    expect(fx.engine.validateExpr(un('-', lit(null)), scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(un('-', param('p')), scope).hasErrors).toBe(false);
  });

  it('evaluate: null / non-numeric / negate / plus', async () => {
    const rfx = runtimeFixture();
    const ctx = new RuntimeContext(rfx.engine);
    expect((await rfx.engine.parse(un('-', lit(null))).evaluate(ctx, null)).isNull()).toBe(true);
    expect((await rfx.engine.parse(un('-', lit('abc'))).evaluate(ctx, null)).isNull()).toBe(true);
    expect((await rfx.engine.parse(un('-', lit(5))).evaluate(ctx, null)).raw).toBe(-5);
    expect((await rfx.engine.parse(un('+', lit(5))).evaluate(ctx, null)).raw).toBe(5);
  });

  it('toSQL emits a parenthesized sign in both dialects', () => {
    const def: SelectDef = { kind: 'select', fields: [{ expr: un('-', ref('order', 'total')), as: 'neg' }], from: { kind: 'type', type: 'order' } };
    for (const d of ['base', 'postgres'] as const) {
      expect(fx.engine.toSQL(def, d).sql).toContain('(-');
    }
  });
});

// ─── select.ts — SQL-92 GROUP BY `group.ungrouped-column` rule ─────────────────

describe('group-by: ungrouped-column rule', () => {
  const fx = fixture();
  const has = (def: SelectDef): boolean =>
    fx.engine.validateQuery(def).list.some((x) => x.code === 'group.ungrouped-column');
  const sum = (f: string): ExprDef => ({ kind: 'aggregate', function: 'sum', args: { value: ref('order', f) } });
  const sel = (extra: Partial<SelectDef>): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('order', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'order' },
    groupBy: [ref('order', 'id')],
    ...extra,
  });

  it('errors on a select column that is neither grouped nor aggregated', () => {
    expect(has(sel({ fields: [{ expr: ref('order', 'id'), as: 'id' }, { expr: ref('order', 'total'), as: 't' }] }))).toBe(true);
  });

  it('accepts a grouped column plus an aggregate over the ungrouped one', () => {
    expect(has(sel({ fields: [{ expr: ref('order', 'id'), as: 'id' }, { expr: sum('total'), as: 'rev' }] }))).toBe(false);
  });

  it('errors on an ungrouped column in ORDER BY', () => {
    expect(has(sel({ order: [{ expr: ref('order', 'total'), dir: 'asc' }] }))).toBe(true);
  });

  it('errors on an ungrouped column in HAVING (recurses into the predicate)', () => {
    expect(has(sel({ having: [cmp('>', ref('order', 'total'), lit(0))] }))).toBe(true);
  });

  it('a window function is exempt (computes over the group)', () => {
    const win: ExprDef = { kind: 'window', function: 'rowNumber', args: {}, orderBy: [{ expr: ref('order', 'id'), dir: 'asc' }] };
    expect(has(sel({ fields: [{ expr: ref('order', 'id'), as: 'id' }, { expr: win, as: 'rn' }] }))).toBe(false);
  });

  it('does not fire without a GROUP BY', () => {
    expect(has({ kind: 'select', fields: [{ expr: ref('order', 'total'), as: 't' }], from: { kind: 'type', type: 'order' } })).toBe(false);
  });
});
