/**
 * A14 — `ComputedResolved.aggregateFn` carries the APPLIED aggregate function.
 *
 * Before `0.6.2` a resolved value said only `aggregate: true | false`; WHICH
 * aggregate was applied lived on the live `AggregateExpr` and never reached a
 * consumer reading `QueryField.type`. Labelling a computed column therefore meant
 * recovering the function from the column's OUTPUT NAME — sound for the common
 * case, because `fieldNameOf` is `as ?? (field-ref ? field : aggregate ? fn :
 * col<i>)` so an unaliased aggregate's name IS its function name — and then
 * confirming that name against the function catalog.
 *
 * That is evidence, not fact, and this file's two load-bearing cases are exactly
 * its dead spots: an ALIASED aggregate, which the name cannot recover at all, and
 * a non-aggregate ALIASED ONTO a function name, which the name recovers as a
 * false positive. Both are asserted through `outputFields` — the surface a
 * consumer actually reads — rather than against `resolve()` in isolation.
 *
 * The negatives matter as much as the positives: a composite over two aggregates
 * has NO single applied function, and a window over an aggregate-shaped function
 * is not an aggregate at all. A regression that propagated the name upward from a
 * child, or that set it for a window, would be caught here and nowhere else.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, ref, lit } from './_utils';
import type { SelectDef, ExprDef } from '../schema';
import type { QueryField } from '../queries/index';

/** An aggregate call def; `arg` omitted ⇒ the `count(*)` empty-args form. */
const agg = (fn: string, arg?: ExprDef): ExprDef => ({
  kind: 'aggregate',
  function: fn,
  args: arg ? { value: arg } : {},
});

const total = ref('order', 'total');

/** `name → aggregateFn` for a SELECT's output fields (`undefined` when unset). */
function aggregateFns(fields: SelectDef['fields']): Record<string, string | undefined> {
  const fx = runtimeFixture();
  const def: SelectDef = {
    kind: 'select',
    fields,
    from: { kind: 'type', type: 'order' },
    groupBy: [ref('order', 'id')],
  };
  const out: Record<string, string | undefined> = {};
  const resolved: QueryField[] = fx.engine
    .parseQuery(def)
    .outputFields(fx.engine, fx.engine.globalScope());
  for (const f of resolved) out[f.name] = f.type.kind === 'computed' ? f.type.aggregateFn : undefined;
  return out;
}

/** `name → aggregate` for the same SELECT — the flag the new field sits beside. */
function aggregateFlags(fields: SelectDef['fields']): Record<string, boolean | undefined> {
  const fx = runtimeFixture();
  const def: SelectDef = {
    kind: 'select',
    fields,
    from: { kind: 'type', type: 'order' },
    groupBy: [ref('order', 'id')],
  };
  const out: Record<string, boolean | undefined> = {};
  for (const f of fx.engine.parseQuery(def).outputFields(fx.engine, fx.engine.globalScope())) {
    out[f.name] = f.type.kind === 'computed' ? f.type.aggregate : undefined;
  }
  return out;
}

describe('aggregateFn — the applied function reaches the resolved type', () => {
  it('names the function on an UNALIASED aggregate (where the name also happened to work)', () => {
    expect(aggregateFns([{ expr: agg('sum', total) }, { expr: agg('count') }])).toEqual({
      sum: 'sum',
      count: 'count',
    });
  });

  it('names it on an ALIASED aggregate — the dead spot the output name cannot reach', () => {
    // `sum(total) as grand_total` projects under a name that says nothing about
    // the function. This is unrecoverable from the name by construction.
    expect(aggregateFns([{ expr: agg('sum', total), as: 'grand_total' }])).toEqual({
      grand_total: 'sum',
    });
  });

  it('leaves it UNSET on a non-aggregate aliased onto a function name — the false positive', () => {
    // `total * 2 as count` recovers `count` from the name. Only `aggregate`
    // rejected it before; now nothing claims it in the first place.
    const fields: SelectDef['fields'] = [
      { expr: { kind: 'binary', op: '*', left: total, right: lit(2) }, as: 'count' },
    ];
    expect(aggregateFns(fields)).toEqual({ count: undefined });
    expect(aggregateFlags(fields)).toEqual({ count: false });
  });

  it('leaves it UNSET on a composite that CONTAINS aggregates but IS none', () => {
    // `max(total) - min(total)` is `aggregate: true` with no single applied
    // function — the case a `false | string` union would have had to invent a
    // value for, and the one a propagate-from-child regression would break.
    const fields: SelectDef['fields'] = [
      {
        expr: { kind: 'binary', op: '-', left: agg('max', total), right: agg('min', total) },
        as: 'spread',
      },
    ];
    expect(aggregateFns(fields)).toEqual({ spread: undefined });
    expect(aggregateFlags(fields)).toEqual({ spread: true }); // still an aggregate SUBTREE
  });

  it('leaves it UNSET on a WINDOW over an aggregate-shaped function', () => {
    // `sum(total) OVER (…)` is per-row and collapses nothing; it already reports
    // `aggregate: false`, and labelling it as an aggregate would be wrong.
    const fields: SelectDef['fields'] = [
      {
        expr: { kind: 'window', function: 'sum', args: { value: total }, partitionBy: [ref('order', 'userId')] },
        as: 'running',
      },
    ];
    expect(aggregateFns(fields)).toEqual({ running: undefined });
    expect(aggregateFlags(fields)).toEqual({ running: false });
  });

  it('leaves it UNSET on a scalar function call and on a plain field', () => {
    // It names the aggregate that was APPLIED, not any function that was called.
    // A plain field-ref resolves to `field`, which has no such notion at all.
    expect(
      aggregateFns([
        { expr: { kind: 'function-call', function: 'upper', args: { value: ref('order', 'note') } }, as: 'up' },
        { expr: ref('order', 'id'), as: 'id' },
      ]),
    ).toEqual({ up: undefined, id: undefined });
  });

  it('carries the name of an UNKNOWN aggregate too (the name is still what was written)', () => {
    // The resolution is a placeholder — `validateWalk` reports `aggregate.unknown`
    // — but the applied name is a fact, and a consumer confirms it against the
    // catalog anyway.
    const fx = runtimeFixture();
    const rt = fx.registry.parseExpr(agg('nope', total)).resolve(fx.engine, fx.engine.globalScope());
    expect(rt.kind).toBe('computed');
    if (rt.kind !== 'computed') return;
    expect(rt.aggregateFn).toBe('nope');
    expect(rt.aggregate).toBe(true);
  });

  it('is OMITTED, not set to undefined, when there is no applied aggregate', () => {
    // A resolved type never carries a key it has no answer for — so a consumer
    // serializing it across a boundary emits nothing rather than a null column.
    const fx = runtimeFixture();
    const rt = fx.registry.parseExpr(ref('order', 'total')).resolve(fx.engine, fx.engine.globalScope());
    const sum = fx.registry.parseExpr(agg('sum', total)).resolve(fx.engine, fx.engine.globalScope());
    expect(Object.prototype.hasOwnProperty.call(rt, 'aggregateFn')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sum, 'aggregateFn')).toBe(true);
  });
});
