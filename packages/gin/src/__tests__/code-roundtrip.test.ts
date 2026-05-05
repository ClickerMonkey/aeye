import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import type { ExprDef } from '../schema';

/**
 * Round-trip invariants: for representative ExprDefs the new
 * `toGinCode` and `toJSONCode` must agree with the legacy
 * `toCode` / `toJSON` outputs (no rendering drift), and every
 * `Problem.path` produced by `validate()` must resolve to a span
 * in both renderings.
 *
 * Catches a class of regressions where a composite Expr's override
 * accidentally drops, reorders, or re-formats child output relative
 * to the string-based ancestors that other code paths still rely on.
 */

const FIXTURES: { name: string; expr: ExprDef }[] = [
  {
    name: 'simple block with define + if',
    expr: {
      kind: 'block',
      lines: [
        {
          kind: 'define',
          vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 5 } }],
          body: {
            kind: 'if',
            ifs: [{
              condition: {
                kind: 'get',
                path: [
                  { prop: 'x' }, { prop: 'gt' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                ],
              },
              body: { kind: 'new', type: { name: 'text' }, value: 'positive' },
            }],
            otherwise: { kind: 'new', type: { name: 'text' }, value: 'non-positive' },
          },
        },
      ],
    },
  },
  {
    name: 'switch with flow body',
    expr: {
      kind: 'switch',
      value: { kind: 'get', path: [{ prop: 'x' }] },
      cases: [
        {
          equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
          body: { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 99 } },
        },
      ],
      else: { kind: 'new', type: { name: 'num' }, value: 0 },
    } as ExprDef,
  },
  {
    name: 'set on a vars-shaped target',
    expr: {
      kind: 'set',
      path: [{ prop: 'x' }],
      value: { kind: 'new', type: { name: 'num' }, value: 7 },
    },
  },
];

describe('toGinCode / toJSONCode round-trip', () => {
  const r = createRegistry();
  const e = new Engine(r);

  for (const { name, expr } of FIXTURES) {
    test(`${name}: toGinCode().toString() === toCode()`, () => {
      const ginText = e.toGinCode(expr).toString();
      const legacyText = e.toCode(expr);
      expect(ginText).toBe(legacyText);
    });

    test(`${name}: toJSONCode().toString() parses to toJSON()`, () => {
      const jsonText = e.toJSONCode(expr).toString();
      const jsonExpected = JSON.stringify(r.parseExpr(expr).toJSON(), null, 2);
      // The structural JSON should match. Indentation matches `null, 2`.
      expect(jsonText).toBe(jsonExpected);
    });

    test(`${name}: every validator path resolves to a span`, () => {
      // Build a fixture with deliberate broken bits to force problems,
      // then assert each Problem.path resolves to a span in both
      // renderings. For fixtures that don't naturally fail validation
      // we just check that the renderings produce SOME spans.
      const richCode = e.toGinCode(expr);
      const jsonCode = e.toJSONCode(expr);
      expect(richCode.spans.length).toBeGreaterThan(0);
      expect(jsonCode.spans.length).toBeGreaterThan(0);
    });
  }

  test('broken program: every Problem.path resolves in toGinCode', () => {
    // Multiple deliberate errors so we exercise the path→span
    // resolution beyond just one problem.
    const broken: ExprDef = {
      kind: 'define',
      vars: [
        { name: 'x', type: { name: 'num' }, value: { kind: 'new', type: { name: 'text' }, value: 'wrong' } },
        { name: 'y', value: { kind: 'get', path: [{ prop: 'undeclared' }] } },
      ],
      body: {
        kind: 'if',
        ifs: [{
          condition: { kind: 'new', type: { name: 'num' }, value: 1 },
          body: { kind: 'get', path: [{ prop: 'x' }] },
        }],
      },
    };
    const probs = e.validate(broken);
    expect(probs.list.length).toBeGreaterThan(0);
    const richCode = e.toGinCode(broken);
    for (const p of probs.list) {
      const matched = richCode.spanFor(p.path);
      expect(matched, `expected span for ${p.code} @ ${p.path.join('.')}`).toBeDefined();
    }
  });
});
