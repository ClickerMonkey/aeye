/**
 * Coverage: cost helpers, Problems.info, resolved-type helpers, Index digest
 * for arrays/null, ParamSet root-path conflict, and QueryScope helpers.
 */
import { describe, it, expect } from 'vitest';
import { fixture } from './_utils';
import { maxCost, scaleRows, rowsCost, addCost, bytesOfResolved } from '../cost';
import { Problems } from '../problem';
import { asFieldType, sourcesOf, widenNullable, isType, isScalar } from '../resolved-type';
import type { FieldResolved, ComputedResolved, TypeResolved } from '../resolved-type';
import { Index } from '../index-spec';
import { ParamSet } from '../param';
import { QueryScope } from '../scope';

describe('cost helpers', () => {
  it('addCost / maxCost / scaleRows / rowsCost', () => {
    expect(addCost({ rows: 1, bytes: 2 }, { rows: 3, bytes: 4 })).toEqual({ rows: 4, bytes: 6 });
    expect(maxCost({ rows: 1, bytes: 9 }, { rows: 5, bytes: 2 })).toEqual({ rows: 5, bytes: 9 });
    expect(scaleRows({ rows: 10, bytes: 100 }, 0.5)).toEqual({ rows: 5, bytes: 50 });
    expect(scaleRows({ rows: 0, bytes: 0 }, 2)).toEqual({ rows: 1, bytes: 0 }); // floored, perRow 0
    expect(rowsCost(5, 8)).toEqual({ rows: 5, bytes: 40 });
    expect(rowsCost(-1, -2)).toEqual({ rows: 0, bytes: 0 }); // clamped
  });

  it('bytesOfResolved: field type has bytes; a whole-Type resolves to 0', () => {
    const fx = fixture();
    const field = fx.user.field('name')!;
    const fieldRt: FieldResolved = { kind: 'field', field, type: fx.user, source: 'user', nullable: false };
    expect(bytesOfResolved(fieldRt)).toBeGreaterThanOrEqual(0);
    const typeRt: TypeResolved = { kind: 'type', type: fx.user, source: 'user', synthetic: false };
    expect(bytesOfResolved(typeRt)).toBe(0);
  });
});

describe('Problems.info', () => {
  it('records an info-severity problem', () => {
    const p = new Problems();
    p.info('note', 'just so you know');
    expect(p.list[0]!.severity).toBe('info');
    expect(p.hasErrors).toBe(false);
  });
});

describe('resolved-type helpers', () => {
  const fx = fixture();
  const field = fx.user.field('age')!;
  const fieldRt: FieldResolved = { kind: 'field', field, type: fx.user, source: 'user', nullable: false };
  const typeRt: TypeResolved = { kind: 'type', type: fx.user, source: 'user', synthetic: false };
  const computedRt: ComputedResolved = {
    kind: 'computed',
    fieldType: field.fieldType,
    sources: [fieldRt],
    nullable: false,
    aggregate: false,
  };

  it('asFieldType / sourcesOf across variants', () => {
    expect(asFieldType(typeRt)).toBeUndefined();
    expect(asFieldType(fieldRt)).toBe(field.fieldType);
    expect(asFieldType(computedRt)).toBe(field.fieldType);
    expect(sourcesOf(typeRt)).toEqual([]);
    expect(sourcesOf(fieldRt)).toEqual([fieldRt]);
    expect(sourcesOf(computedRt)).toEqual([fieldRt]);
  });

  it('widenNullable: types unchanged, field/computed copy only when differing', () => {
    expect(widenNullable(typeRt)).toBe(typeRt);
    expect(widenNullable(fieldRt, false)).toBe(fieldRt); // already false → same ref
    expect(widenNullable(fieldRt, true)).not.toBe(fieldRt); // differs → copy
    expect((widenNullable(fieldRt, true) as FieldResolved).nullable).toBe(true);
    expect(widenNullable(computedRt, false)).toBe(computedRt);
    expect((widenNullable(computedRt, true) as ComputedResolved).nullable).toBe(true);
  });

  it('isType / isScalar guards', () => {
    expect(isType(typeRt)).toBe(true);
    expect(isType(fieldRt)).toBe(false);
    expect(isScalar(fieldRt)).toBe(true);
    expect(isScalar(typeRt)).toBe(false);
  });
});

describe('Index digest for arrays + null; clone', () => {
  it('handles array + null literal expr values', () => {
    const idx = Index.from({ exprs: [{ expr: { kind: 'literal', value: [1, null] }, count: 1 }] });
    expect(typeof idx.parts[0]!.digest).toBe('string');
    const cloned = idx.clone();
    expect(cloned.parts[0]!.digest).toBe(idx.parts[0]!.digest);
    expect(cloned).not.toBe(idx);
  });
});

describe('ParamSet root-path conflict', () => {
  it('names (root) when a conflicting observation has an empty path', () => {
    const fx = fixture();
    const num = fx.registry.parseFieldType({ kind: 'number' });
    const txt = fx.registry.parseFieldType({ kind: 'text' });
    const ps = new ParamSet();
    ps.observe('x', num, []);
    ps.observe('x', txt, []);
    const p = new Problems();
    ps.problems(p);
    expect(p.list.some((pr) => pr.code === 'param.conflict')).toBe(true);
    expect(p.list.find((pr) => pr.code === 'param.conflict')!.message).toContain('(root)');
  });
});

describe('QueryScope helpers', () => {
  it('localSources + parent ParamSet reuse', () => {
    const root = new QueryScope();
    root.bind('u', { kind: 'type', type: fixture().user, source: 'u', synthetic: false });
    expect(root.localSources()).toEqual(['u']);
    // A child constructed WITHOUT explicit params reuses the parent's ParamSet.
    const child = new QueryScope(root);
    expect(child.params).toBe(root.params);
    expect(child.has('u')).toBe(true);
    expect(child.localSources()).toEqual([]);
    // A brand-new root creates a fresh ParamSet.
    expect(new QueryScope().params).not.toBe(root.params);
  });
});
