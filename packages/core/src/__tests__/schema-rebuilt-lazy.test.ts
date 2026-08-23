/**
 * A `z.lazy` is only required to return *a* schema from its getter — not the
 * *same* schema object. A codegen layer that derives zod from a live type
 * registry (`@aeye/gin`'s `buildSchemas`, `@aeye/query`'s) rebuilds the subtree
 * on every call, so every re-entry into a recursive node is a FRESH object.
 *
 * Any EAGER walk whose cycle guard is object identity therefore never fires its
 * guard, descends forever, and — because each level allocates a whole new
 * subtree rather than pushing a stack frame — dies of heap exhaustion rather
 * than overflowing the stack.
 *
 * That is not a hypothetical: it is what `SchemaBudget.allocate`'s unconditional
 * `analyzeSchema` call did to every request to a strict-family model that
 * offered a gin-schema'd tool. The process burned 8 GB and 22 minutes with the
 * event loop blocked (so nothing downstream even logged) before V8 gave up with
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`.
 *
 * These tests use the SAME shape — a getter that returns a newly-built schema
 * each call, tagged with a stable `aid` the way a codegen layer tags its named
 * definitions — and assert every eager walker terminates. Without the fix each
 * one hangs until the heap is gone, so a timeout here is the failure signal.
 */

import { z } from 'zod';
import {
  analyzeSchema,
  canExpress,
  GOOGLE_NON_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_STRICT,
  SchemaBudget,
  strictify,
  toJSONSchema,
} from '../index';

/**
 * A recursive schema whose lazy getter REBUILDS.
 *
 * The recursive positions call `node()` again rather than closing over one
 * `lazy` constant, and that detail is the entire point: closing over a constant
 * gives every re-entry the SAME object, which an identity guard catches, so a
 * fixture written that way passes with or without the fix and proves nothing.
 * (It was written that way first; a mutation run is what caught it.) A codegen
 * layer builds the tree from its registry each time, so it takes this shape.
 *
 * `calls` counts getter evaluations so a test can prove the walk is bounded by
 * the declared id rather than merely slow.
 */
function rebuildingRecursiveSchema(): { schema: z.ZodType; calls: () => number } {
  let calls = 0;
  const node = (): z.ZodType =>
    z.lazy(() => {
      calls += 1;
      // A FRESH object graph every call — nothing here is memoized.
      return z.object({
        name: z.string(),
        child: node().optional(),
        children: z.array(node()),
      });
    }).meta({ aid: 'Node' });
  return { schema: node(), calls: () => calls };
}

/** The same, wrapped so the cycle is NOT back to the root. */
function nonRootRebuildingSchema(): z.ZodType {
  const { schema } = rebuildingRecursiveSchema();
  return z.object({ label: z.string(), tree: schema });
}

describe('a z.lazy getter that rebuilds', () => {
  it('does not defeat the getter — it really is a new object each call', () => {
    const { schema } = rebuildingRecursiveSchema();
    const lazy = schema as z.ZodLazy<z.ZodType>;
    expect(lazy.def.getter()).not.toBe(lazy.def.getter());
  });

  it('analyzeSchema terminates and reports the recursion', () => {
    const { schema, calls } = rebuildingRecursiveSchema();
    const features = analyzeSchema(schema);
    expect(features.hasRecursion).toBe(true);
    // The declared `aid` bounds the descent: the getter is evaluated a handful
    // of times, not until the heap dies.
    expect(calls()).toBeLessThan(50);
  });

  it('analyzeSchema terminates when the recursion is not at the root', () => {
    expect(analyzeSchema(nonRootRebuildingSchema()).hasRecursion).toBe(true);
  });

  it('canExpress terminates under every shipped descriptor', () => {
    for (const descriptor of [LENIENT, OPENAI_STRICT, GOOGLE_STRICT]) {
      const { schema } = rebuildingRecursiveSchema();
      // The assertion that matters is that this RETURNS; the verdict itself is
      // `canExpress`'s own contract and is pinned by can-express.test.ts.
      expect(typeof canExpress(schema, descriptor)).toBe('boolean');
    }
  });

  it('SchemaBudget.allocateTool terminates for every strict request shape', () => {
    for (const requested of [undefined, 0, 1, true] as const) {
      const { schema } = rebuildingRecursiveSchema();
      const budget = new SchemaBudget(GOOGLE_STRICT);
      expect(budget.allocateTool(schema, requested).id).toBeDefined();
    }
  });

  it('toJSONSchema terminates and emits a finite schema', () => {
    const { schema } = rebuildingRecursiveSchema();
    const json = JSON.stringify(toJSONSchema(strictify(schema, LENIENT), LENIENT));
    expect(json.length).toBeGreaterThan(0);
    expect(json.length).toBeLessThan(200_000);
  });
});

describe('SchemaBudget honours the descriptor it cannot send', () => {
  it('degrades a union-bearing tool to GOOGLE_NON_STRICT (allowAnyOf: false), never to LENIENT', () => {
    // The api_set case in miniature: a recursive UNION is the shape a gin
    // program schema takes, and `anyOf` is the one thing nothing rewrites away.
    //
    // WHICH descriptor it degrades to is the point. `LENIENT` encodes
    // `z.any()` as a self-referencing `$defs/Any`, which is precisely what
    // `GOOGLE_NON_STRICT` exists to keep off the Google wire: Gemini compiles a
    // decoding grammar whenever a tool call is forced, with no per-tool strict
    // flag involved. Degrading to LENIENT put that shape back on every schema
    // that degrades — which, under `GOOGLE_STRICT`, is every gin program schema
    // there is.
    const schema = z.object({ value: z.union([z.string(), z.number()]) });
    const budget = new SchemaBudget(GOOGLE_STRICT);
    expect(budget.allocateTool(schema, 1)).toBe(GOOGLE_NON_STRICT);
    // A hard `strict: true` is degraded too — feasibility is not a budget
    // question, and emitting it would be a guaranteed 400.
    expect(budget.allocateTool(schema, true)).toBe(GOOGLE_NON_STRICT);
  });

  it('the degraded tool emits Google\'s "any" encoding, not a recursive $defs/Any', () => {
    // The consequence the swap buys, asserted on the WIRE rather than on a
    // descriptor identity: a degraded Google tool must carry no `$defs/Any`.
    const schema = z.object({ value: z.union([z.string(), z.number()]), payload: z.any() });
    const budget = new SchemaBudget(GOOGLE_STRICT);
    const descriptor = budget.allocateTool(schema, true);
    const json = JSON.stringify(toJSONSchema(strictify(schema, descriptor), descriptor));
    expect(json).not.toContain('$defs');
    expect(json).not.toContain('$ref');
    // Same schema through the old target, so the assertion above is known to
    // be capable of failing.
    expect(JSON.stringify(toJSONSchema(strictify(schema, LENIENT), LENIENT))).toContain('#/$defs/Any');
  });

  it('still grants strict for a schema the descriptor CAN send', () => {
    const schema = z.object({ value: z.string(), count: z.number() });
    const budget = new SchemaBudget(GOOGLE_STRICT);
    expect(budget.allocateTool(schema, 1)).toBe(GOOGLE_STRICT);
  });

  it('grants strict for a RECURSIVE schema — the cycle-breaker makes it sendable', () => {
    // Looser than the source at the back-edge, but never rejected: degrading it
    // would trade a real strict guarantee for nothing. (`canExpress` answers the
    // other question — whether the model is properly constrained — and is what
    // the structured-OUTPUT fallback uses.)
    const { schema } = rebuildingRecursiveSchema();
    const budget = new SchemaBudget(GOOGLE_STRICT);
    expect(budget.allocateTool(schema, 1)).toBe(GOOGLE_STRICT);
  });
});
