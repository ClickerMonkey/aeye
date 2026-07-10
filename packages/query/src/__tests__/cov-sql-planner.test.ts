/**
 * Coverage: the `JoinCtePlanner` — dedup, every join keyword, the implicit
 * (UPDATE…FROM / DELETE…USING) lowering, and the no-comma-list error paths.
 */
import { describe, it, expect } from 'vitest';
import { JoinCtePlanner } from '../sql/planner';
import type { JoinRequest, LateralRequest, RawJoinRequest } from '../sql/planner';
import { BaseDialect } from '../sql/index';
import { SqlText } from '../sql/emit';
import { fixture } from './_utils';

const dialect = new BaseDialect();
const render = (t: SqlText): string => t.render(dialect).sql;

/** A plain belongs-to JoinRequest order→user, optionally with a join type. */
function joinReq(over: Partial<JoinRequest> = {}): JoinRequest {
  const fx = fixture();
  return {
    leftAlias: 'order',
    alias: 'order_userId',
    targetType: fx.user,
    keys: [{ localField: 'userId', foreignField: 'id' }],
    joinType: 'left',
    ...over,
  };
}

describe('cov planner: explicit (JOIN-clause) mode', () => {
  it('requireJoin dedups on (alias, andKey)', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined);
    const a = p.requireJoin(joinReq({ targetType: fx.user }));
    const b = p.requireJoin(joinReq({ targetType: fx.user }));
    expect(a).toBe('order_userId');
    expect(b).toBe('order_userId');
    expect(p.emittedJoins().length).toBe(1);
    expect(render(p.emittedJoins()[0]!)).toBe(
      'LEFT JOIN "user" AS "order_userId" ON "order"."userId" = "order_userId"."id"',
    );
  });

  it('distinct andKey ⇒ two joins; extraOn is ANDed', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined);
    p.requireJoin(joinReq({ targetType: fx.user }));
    p.requireJoin(joinReq({ targetType: fx.user, andKey: 'k2', extraOn: SqlText.raw('1 = 1') }));
    expect(p.emittedJoins().length).toBe(2);
    expect(render(p.emittedJoins()[1]!)).toContain('AND 1 = 1');
  });

  it('every join keyword (inner / left / right / full)', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined);
    p.requireJoin(joinReq({ targetType: fx.user, alias: 'j_inner', joinType: 'inner' }));
    p.requireJoin(joinReq({ targetType: fx.user, alias: 'j_left', joinType: 'left' }));
    p.requireJoin(joinReq({ targetType: fx.user, alias: 'j_right', joinType: 'right' }));
    p.requireJoin(joinReq({ targetType: fx.user, alias: 'j_full', joinType: 'full' }));
    const all = p.emittedJoins().map(render).join(' | ');
    expect(all).toContain('INNER JOIN');
    expect(all).toContain('LEFT JOIN');
    expect(all).toContain('RIGHT JOIN');
    expect(all).toContain('FULL JOIN');
  });

  it('requireLateral + requireRawJoin dedup', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined);
    const lat: LateralRequest = { alias: 'lx', subquery: SqlText.raw('SELECT 1'), joinType: 'left', key: 'k' };
    expect(p.requireLateral(lat)).toBe('lx');
    expect(p.requireLateral(lat)).toBe('lx');
    const rawJoin: RawJoinRequest = { alias: 'rx', sql: SqlText.raw('LEFT JOIN x ON 1=1'), key: 'k' };
    expect(p.requireRawJoin(rawJoin)).toBe('rx');
    expect(p.requireRawJoin(rawJoin)).toBe('rx');
    // one lateral + one raw join (deduped)
    expect(p.emittedJoins().length).toBe(2);
  });
});

describe('cov planner: implicit (UPDATE…FROM / DELETE…USING) mode', () => {
  it('relation join lowers to FROM item + WHERE predicate', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined, {}, true);
    const alias = p.requireJoin(joinReq({ targetType: fx.user, joinType: 'left' }));
    expect(alias).toBe('order_userId');
    expect(p.hasFromItems()).toBe(true);
    expect(p.emittedJoins().length).toBe(0);
    expect(render(p.emittedFromItems()[0]!)).toBe('"user" AS "order_userId"');
    expect(render(p.emittedJoinPredicates()[0]!)).toBe('"order"."userId" = "order_userId"."id"');
    // dedup still holds in implicit mode
    p.requireJoin(joinReq({ targetType: fx.user, joinType: 'left' }));
    expect(p.emittedFromItems().length).toBe(1);
  });

  it('RIGHT / FULL relation joins have no comma-list form', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined, {}, true);
    expect(() => p.requireJoin(joinReq({ targetType: fx.user, joinType: 'right' }))).toThrow(/cannot be expressed/);
    expect(() => p.requireJoin(joinReq({ targetType: fx.user, joinType: 'full' }))).toThrow(/cannot be expressed/);
  });

  it('LATERAL / raw named joins cannot be expressed implicitly', () => {
    const fx = fixture();
    const p = new JoinCtePlanner(dialect, fx.engine, undefined, {}, true);
    expect(() => p.requireLateral({ alias: 'lx', subquery: SqlText.raw('SELECT 1'), joinType: 'left' })).toThrow(/LATERAL/);
    expect(() => p.requireRawJoin({ alias: 'rx', sql: SqlText.raw('JOIN x') })).toThrow(/raw join/);
  });
});
