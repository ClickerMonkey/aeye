/**
 * Planning speed (step 2): the fitting ladder bisects caps and depths, never
 * widens enums it doesn't have to, and measuring a recursive grammar's depth
 * is no longer exponential. Work is counted (renders), not timed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { a, Bound, measureJson, ModelProfile, OPENAI_STRICT, variant, type AnySchema, type Profile } from '../index';
import { QueryToolArgs } from './corpus/cletus-dba';
import { TYPES } from './corpus/cletus-dba-fixtures';

/** The depth measure before step 2: every simple path through the `$ref` graph (exponential on recursive grammars). */
function naiveDepth(schema: Record<string, unknown>): number {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const { $defs: _d, ...body } = schema;
  const depthOf = (j: unknown, open: Set<string>): number => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 0;
    const o = j as Record<string, any>;
    if (typeof o.$ref === 'string') {
      const name = /^#\/\$defs\/(.+)$/.exec(o.$ref)?.[1];
      if (!name || open.has(name) || !defs[name]) return 0;
      open.add(name);
      const d = depthOf(defs[name], open);
      open.delete(name);
      return d;
    }
    const container = o.type === 'object' || o.type === 'array';
    let inner = 0;
    const visit = (x: unknown) => { inner = Math.max(inner, depthOf(x, open)); };
    if (o.properties) for (const p of Object.values(o.properties)) visit(p);
    for (const k of ['items', 'additionalProperties', 'not']) if (k in o) visit(o[k]);
    for (const k of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) if (Array.isArray(o[k])) for (const x of o[k]) visit(x);
    return (container ? 1 : 0) + inner;
  };
  return depthOf(body, new Set());
}

/** A seeded random `$defs` graph: objects and arrays, refs between defs, cycles included. */
function randomGrammar(seed: number, n: number): Record<string, unknown> {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ref = () => ({ $ref: `#/$defs/D${Math.floor(rnd() * n)}` });
  const node = (depth: number): Record<string, unknown> => {
    const r = rnd();
    if (depth > 2 || r < 0.25) return r < 0.12 ? { type: 'string' } : ref();
    if (r < 0.5) return { type: 'array', items: node(depth + 1) };
    if (r < 0.65) return { anyOf: [node(depth + 1), node(depth + 1)] };
    const props: Record<string, unknown> = {};
    for (let i = 0, k = 1 + Math.floor(rnd() * 3); i < k; i++) props[`p${i}`] = node(depth + 1);
    return { type: 'object', properties: props };
  };
  const $defs: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) $defs[`D${i}`] = node(0);
  return { type: 'object', properties: { root: ref() }, $defs };
}

describe('measuring depth through recursive grammars', () => {
  it('matches the exhaustive walk on 200 random recursive grammars', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = randomGrammar(seed, 3 + (seed % 7));
      expect(measureJson(g as never).depth).toBe(naiveDepth(g));
    }
  });

  it('a fully connected grammar of 12 types finishes (the exhaustive walk would take 12! paths)', () => {
    const n = 12;
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      $defs[`D${i}`] = { type: 'object', properties: Object.fromEntries(Array.from({ length: n }, (_, j) => [`to${j}`, { $ref: `#/$defs/D${j}` }])) };
    }
    // The longest path enters every type once: 12 objects deep.
    expect(measureJson({ $ref: '#/$defs/D0', $defs } as never).depth).toBe(n);
  });
});

// ---- the ladder ------------------------------------------------------------

let renders = 0;
const realRender = Bound.prototype.render;
beforeEach(() => {
  renders = 0;
  Bound.prototype.render = function (this: Bound<unknown>, profile: Profile) {
    if (!(this as unknown as { rendered: Map<string, unknown> }).rendered.has(profile.id)) renders++;
    return realRender.call(this, profile) as never;
  };
});
afterEach(() => { Bound.prototype.render = realRender; });

/** A chain of `n` nested objects: `n` levels deep, no refs. */
const nested = (n: number): AnySchema => {
  let s: AnySchema = a.object({ leaf: a.string() });
  for (let i = 1; i < n; i++) s = a.object({ [`l${i}`]: s });
  return s;
};

describe('the fitting ladder', () => {
  it('bisects the depth: a 200-level schema under a 50-level limit takes a logarithmic number of renders', () => {
    // No depth of its own (OpenAI strict escapes at 10): only the 50-level limit.
    const { maxDepth: _own, ...noEscape } = OPENAI_STRICT;
    const deep: Profile = { ...noEscape, id: 'plan-test-deep', limits: { ...OPENAI_STRICT.limits, maxDepth: 50, maxProperties: 10_000 } };
    const e = ModelProfile.of(deep).request([{ kind: 'tool', name: 'deep', schema: nested(200) as never }]).get('deep');
    expect(e.strict).toBe(true);
    const d = e.adjustments.find((x) => x.kind === 'depth-limited') as { maxDepth: number };
    // The deepest level that fits: one more would not.
    expect(e.measure.depth).toBeLessThanOrEqual(50);
    const deeper = (nested(200) as unknown as { bind(): Bound<unknown> }).bind().render(variant(deep, { rootObject: true, maxDepth: d.maxDepth + 1 }));
    expect(deeper.measure.depth).toBeGreaterThan(50);
    // Walking down from 199 levels took ~150 renders; bisecting: base + shallowest + ⌈log2 199⌉ (+ LENIENT for the escapes).
    expect(renders).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(199)) + 2);
  });

  it('enums alone: the largest cap that fits, found by bisecting the caps, and no depth cut', () => {
    const values = (k: number) => Array.from({ length: 300 }, (_, i) => `v${k}_${i}`) as [string, ...string[]];
    const wide = a.object(Object.fromEntries(Array.from({ length: 5 }, (_, k) => [`e${k}`, a.enum(values(k))])));
    const e = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'wide', schema: wide as never }]).get('wide');
    expect(e.adjustments).toEqual([{ kind: 'enums-widened', maxEnumValues: 250 }]);
    expect(renders).toBeLessThanOrEqual(1 + 3 + 1);
  });

  it('a depth-only overflow keeps the enums; an overflow widening can\'t fix skips the enum rungs', () => {
    const data = { types: TYPES, user: { maxQuerySchemaTypes: 10 } };
    const e = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'query', schema: QueryToolArgs.bind({ config: { getData: () => data } }) }]).get('query');
    expect(e.reasons).toEqual(['"query": 17 levels of nesting (limit 10)']);
    expect(e.adjustments).toEqual([{ kind: 'depth-limited', maxDepth: 5 }]);
    // Before: 2 enum rungs + 5 depth rungs (each with every enum widened), measured at 0.66 s each.
    expect(renders).toBeLessThanOrEqual(8);
  });

  it('when even the shallowest cut doesn\'t fit, the search stops there', () => {
    const { maxDepth: _own, ...noEscape } = OPENAI_STRICT;
    const tiny: Profile = { ...noEscape, id: 'plan-test-tiny', limits: { ...OPENAI_STRICT.limits, maxProperties: 0 } };
    const e = ModelProfile.of(tiny).request([{ kind: 'tool', name: 'deep', schema: nested(40) as never }]).get('deep');
    expect(e.strict).toBe(false);
    // base, the shallowest cut, the loose rendering it falls back to (+ LENIENT).
    expect(renders).toBeLessThanOrEqual(4);
  });
});
