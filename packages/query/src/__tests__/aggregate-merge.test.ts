/**
 * A19 — an aggregate DECLARES how its values merge, and DISTINCT survives
 * resolution.
 *
 * The consumer is a visual that cannot draw every group and folds the tail into
 * a residual (a pie's *Other* slice, a cross-tab's *Other* row/column). That is
 * only honest if the residual is the true value OVER THE GROUPS IT REPLACES, so
 * the widget layer has to answer "given one value per group, what is the value
 * over all of them?" — a property of the FUNCTION, which nothing on the wire
 * carried. The alternative is a hard-coded per-function table in every consumer,
 * which is wrong the moment a caller registers an aggregate of its own.
 *
 * Two facts land here, and the second is the sharper one:
 *  1. `FunctionDef.merge` declares the operation, and `ComputedResolved`
 *     surfaces it per CALL as `aggregateMerge`.
 *  2. Before `0.6.5`, `count(hours)` and `count(DISTINCT hours)` resolved to
 *     BYTE-IDENTICAL output fields — same fieldType, same nullable, same
 *     `aggregateFn`, same single source — while emitting different SQL and
 *     answering different questions. `aggregateDistinct` is that missing fact,
 *     and `aggregateMerge` is why it matters: de-duplication is global, so two
 *     `count(DISTINCT …)` values cannot be added.
 *
 * Asserted through `outputFields` — the surface a consumer actually reads —
 * rather than against `resolve()` in isolation, matching `aggregate-fn-resolved`.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, ref, lit } from './_utils';
import { mergeOfAggregateCall } from '../function';
import type { AggregateMerge, ExprDef, SelectDef } from '../schema';
import type { QueryField } from '../queries/index';

/** An aggregate call def; `arg` omitted ⇒ the `count(*)` empty-args form. */
const agg = (fn: string, arg?: ExprDef, distinct?: boolean): ExprDef => ({
  kind: 'aggregate',
  function: fn,
  args: arg ? { value: arg } : {},
  ...(distinct ? { distinct: true } : {}),
});

const total = ref('order', 'total');

/** The resolved output fields of a grouped SELECT over `order`. */
function outputs(fields: SelectDef['fields']): QueryField[] {
  const fx = runtimeFixture();
  const def: SelectDef = {
    kind: 'select',
    fields,
    from: { kind: 'type', type: 'order' },
    groupBy: [ref('order', 'userId')],
  };
  return fx.engine.parseQuery(def).outputFields(fx.engine, fx.engine.globalScope());
}

/** The three applied-aggregate facts for a single projected expression. */
function applied(expr: ExprDef): { fn?: string; distinct?: boolean; merge?: AggregateMerge } {
  const f = outputs([{ expr, as: 'x' }])[0]!;
  if (f.type.kind !== 'computed') return {};
  return { fn: f.type.aggregateFn, distinct: f.type.aggregateDistinct, merge: f.type.aggregateMerge };
}

describe('A19 — every builtin aggregate declares its merge', () => {
  it('declares the operation that is TRUE for every partition, and nothing more', () => {
    const fx = runtimeFixture();
    const merges: Record<string, AggregateMerge | undefined> = {};
    for (const def of fx.registry.functionList()) {
      if (def.shape !== 'aggregate') continue;
      merges[def.name] = fx.engine.lookupFunction(def.name)?.merge;
    }
    expect(merges).toEqual({
      // Additive.
      count: 'sum',
      sum: 'sum',
      countIf: 'sum',
      // Extremal — min of the mins is the min of the union.
      min: 'min',
      max: 'max',
      // Boolean folds.
      boolAnd: 'and',
      boolOr: 'or',
      // NOT recoverable from the values alone. `avg` needs each group's WEIGHT
      // (see the worked case below); `stddev` / `variance` need the same;
      // `stringAgg` / `arrayAgg` need a separator / ordering two values lack.
      avg: 'none',
      stddev: 'none',
      variance: 'none',
      stringAgg: 'none',
      arrayAgg: 'none',
    });
  });

  it("`avg` is 'none' — the worked case a consumer would otherwise get wrong", () => {
    // Four owners, hours logged, grouped by owner, drawing two and folding two:
    //   Cy  1 row,  10 hours ⇒ avg 10
    //   Dee 9 rows, 18 hours ⇒ avg  2
    // The residual over Cy ∪ Dee is (10 + 18) / 10 = 2.8. Adding the cells gives
    // 12; averaging them gives 6. Both are numbers a reader accepts without
    // hesitating, both are wrong, and the input that would fix it — each group's
    // row COUNT — is not in the result at all. So the only correct answer the
    // library can give is "you cannot".
    expect(applied(agg('avg', total)).merge).toBe('none');
  });

  it('a function that declares nothing reports `none`, so a consumer fails SAFE', () => {
    const fx = runtimeFixture();
    fx.registry.registerFunction({
      name: 'median',
      shape: 'aggregate',
      params: [{ name: 'value', type: { kind: 'number' } }],
      output: { kind: 'number' },
    });
    expect(fx.engine.lookupFunction('median')?.merge).toBe('none');
  });

  it('a CALLER-registered aggregate that declares one is answered like a builtin', () => {
    // The point of declaring the fact on the FUNCTION: a consumer written today
    // is correct for an aggregate a system registers tomorrow, with no edit.
    const fx = runtimeFixture();
    fx.registry.registerFunction({
      name: 'total2',
      shape: 'aggregate',
      params: [{ name: 'value', type: { kind: 'number' } }],
      output: { kind: 'number' },
      merge: 'sum',
    });
    expect(fx.engine.lookupFunction('total2')?.merge).toBe('sum');
    const rt = fx.registry.parseExpr(agg('total2', total)).resolve(fx.engine, fx.engine.globalScope());
    expect(rt.kind === 'computed' && rt.aggregateMerge).toBe('sum');
  });

  it('refuses a merge on a function that is not an aggregate', () => {
    const fx = runtimeFixture();
    fx.registry.registerFunction({
      name: 'biggest',
      shape: 'scalar',
      params: [{ name: 'value', type: { kind: 'number' } }],
      output: { kind: 'number' },
      merge: 'max',
    });
    // A merge is a claim about combining PER-GROUP values, and a scalar produces
    // none — so this is a declaration error, not a key to ignore.
    expect(() => fx.engine.lookupFunction('biggest')).toThrow(/declares merge 'max' but is 'scalar'/);
  });

  it('round-trips through `toJSON`, and omits the neutral default', () => {
    const fx = runtimeFixture();
    expect(fx.engine.lookupFunction('sum')!.toJSON().merge).toBe('sum');
    expect(Object.prototype.hasOwnProperty.call(fx.engine.lookupFunction('avg')!.toJSON(), 'merge')).toBe(false);
  });
});

describe('A19 — DISTINCT reaches the resolved output, and cancels an additive merge', () => {
  it('separates `count(x)` from `count(DISTINCT x)` — identical fields before 0.6.5', () => {
    expect(applied(agg('count', total))).toEqual({ fn: 'count', distinct: false, merge: 'sum' });
    // Same function, same arg, same output type — a DIFFERENT question. Adding
    // two `count(DISTINCT …)` cells over-counts every value present in both.
    expect(applied(agg('count', total, true))).toEqual({ fn: 'count', distinct: true, merge: 'none' });
  });

  it('cancels `sum` but NOT the idempotent operations', () => {
    expect(applied(agg('sum', total, true)).merge).toBe('none');
    // De-duplication cannot change a min / max / boolean fold: the extremum of a
    // set is the extremum of the set with its duplicates, so the merge survives.
    expect(applied(agg('min', total, true)).merge).toBe('min');
    expect(applied(agg('max', total, true)).merge).toBe('max');
  });

  it('`mergeOfAggregateCall` is TOTAL over the vocabulary (the rule, not the table)', () => {
    const arms: readonly AggregateMerge[] = ['sum', 'min', 'max', 'and', 'or', 'none'];
    const plain = Object.fromEntries(arms.map((m) => [m, mergeOfAggregateCall(m, false)]));
    const distinct = Object.fromEntries(arms.map((m) => [m, mergeOfAggregateCall(m, true)]));
    expect(plain).toEqual({ sum: 'sum', min: 'min', max: 'max', and: 'and', or: 'or', none: 'none' });
    expect(distinct).toEqual({ sum: 'none', min: 'min', max: 'max', and: 'and', or: 'or', none: 'none' });
    // An undeclared merge is `'none'` either way — the total answer for a
    // function whose author said nothing.
    expect([mergeOfAggregateCall(undefined, false), mergeOfAggregateCall(undefined, true)]).toEqual(['none', 'none']);
  });
});

describe('A19 — the three applied facts travel together', () => {
  it('are present exactly when `aggregateFn` is', () => {
    // A composite over two aggregates has NO single applied function, so it has
    // no distinct-ness and no merge either. A regression that stamped a merge
    // from a child would be caught here.
    const spread: ExprDef = { kind: 'binary', op: '-', left: agg('max', total), right: agg('min', total) };
    expect(applied(spread)).toEqual({ fn: undefined, distinct: undefined, merge: undefined });
    const f = outputs([{ expr: spread, as: 'x' }])[0]!;
    expect(f.type.kind === 'computed' && f.type.aggregate).toBe(true); // still an aggregate SUBTREE
  });

  it('are OMITTED, not set to undefined, on a plain non-aggregate', () => {
    const fx = runtimeFixture();
    const rt = fx.registry.parseExpr({ kind: 'binary', op: '*', left: total, right: lit(2) })
      .resolve(fx.engine, fx.engine.globalScope());
    for (const key of ['aggregateFn', 'aggregateDistinct', 'aggregateMerge']) {
      expect(Object.prototype.hasOwnProperty.call(rt, key)).toBe(false);
    }
  });

  it('are carried for an UNKNOWN aggregate too, with a merge of `none`', () => {
    // The resolution is a placeholder (`validateWalk` reports `aggregate.unknown`)
    // but the written name and DISTINCT are facts; an unknown function declares
    // no merge, so the only honest answer is that it cannot be combined.
    const fx = runtimeFixture();
    const rt = fx.registry.parseExpr(agg('nope', total, true)).resolve(fx.engine, fx.engine.globalScope());
    expect(rt.kind).toBe('computed');
    if (rt.kind !== 'computed') return;
    expect([rt.aggregateFn, rt.aggregateDistinct, rt.aggregateMerge]).toEqual(['nope', true, 'none']);
  });

  it('a WINDOW over an aggregate-shaped function still carries none of them', () => {
    // It is per-row and collapses nothing — there are no groups to merge.
    const running: ExprDef = {
      kind: 'window',
      function: 'sum',
      args: { value: total },
      partitionBy: [ref('order', 'userId')],
    };
    expect(applied(running)).toEqual({ fn: undefined, distinct: undefined, merge: undefined });
  });
});

describe('A19 — a DISTINCT with no arguments is refused, not emitted', () => {
  const distinctStar: SelectDef = {
    kind: 'select',
    fields: [{ expr: agg('count', undefined, true), as: 'n' }],
    from: { kind: 'type', type: 'order' },
  };

  it('reports `aggregate.distinct-no-args` rather than emitting invalid SQL', () => {
    const fx = runtimeFixture();
    expect(fx.engine.validateQuery(distinctStar).list.map((p) => p.code)).toContain('aggregate.distinct-no-args');
  });

  it('emits `count(*)`, matching the runtime, which has always ignored the flag', () => {
    // `count(DISTINCT *)` is a syntax error on every dialect, while
    // `AggregateExpr.evaluate` deliberately skips the de-dupe when there are no
    // args — emit and run now agree instead of disagreeing silently.
    const fx = runtimeFixture();
    expect(fx.engine.toSQL(distinctStar, 'base').sql).toContain('count(*)');
    expect(fx.engine.toSQL(distinctStar, 'postgres').sql).not.toContain('DISTINCT');
  });
});
