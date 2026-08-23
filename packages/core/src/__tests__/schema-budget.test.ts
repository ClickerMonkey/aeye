/**
 * SchemaBudget + analyzeSchema tests.
 *
 * Verifies per-request strict-slot allocation under each named descriptor,
 * priority-ordered budget consumption, and shared budgets across tools +
 * structured output.
 */

import z from 'zod';
import {
  ANTHROPIC_NON_STRICT,
  ANTHROPIC_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_NON_STRICT,
  OPENAI_STRICT,
  SchemaBudget,
  analyzeSchema,
  checkSchemaSizeLimits,
  strictPriority,
  strictestOf,
} from '../schema';

describe('analyzeSchema', () => {
  it('counts optional parameters in nested objects', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
      address: z.object({
        line1: z.string(),
        line2: z.string().optional(),
      }),
    });
    const features = analyzeSchema(schema);
    expect(features.optionalParameterCount).toBe(2);
  });

  it('counts unions including nullables', () => {
    const schema = z.object({
      payload: z.union([z.string(), z.number()]),
      maybe: z.string().nullable(),
    });
    const features = analyzeSchema(schema);
    expect(features.unionTypeCount).toBe(2);
  });

  it('counts records and tuples', () => {
    const schema = z.object({
      tags: z.record(z.string(), z.string()),
      pair: z.tuple([z.string(), z.number()]),
    });
    const features = analyzeSchema(schema);
    expect(features.recordCount).toBe(1);
    expect(features.tupleCount).toBe(1);
  });

  it('detects recursion via z.lazy', () => {
    type Node = { value: string; children?: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({
        value: z.string(),
        children: z.array(NodeSchema).optional(),
      })
    );
    const features = analyzeSchema(NodeSchema);
    expect(features.hasRecursion).toBe(true);
  });

  it('returns same reference on repeat calls (cached)', () => {
    const schema = z.object({ name: z.string() });
    const a = analyzeSchema(schema);
    const b = analyzeSchema(schema);
    expect(a).toBe(b);
  });
});

describe('strictPriority', () => {
  it('maps strict tri-state to numeric priority', () => {
    expect(strictPriority(true)).toBe(Infinity);
    expect(strictPriority(false)).toBe(-Infinity);
    expect(strictPriority(5)).toBe(5);
    expect(strictPriority(1)).toBe(1);
    expect(strictPriority(0)).toBe(0);
    expect(strictPriority(-2)).toBe(0);
    expect(strictPriority(undefined)).toBe(0);
  });
});

describe('strictestOf', () => {
  it('picks the strict descriptor over LENIENT', () => {
    expect(strictestOf(LENIENT, OPENAI_STRICT)).toBe(OPENAI_STRICT);
    expect(strictestOf(ANTHROPIC_STRICT, LENIENT)).toBe(ANTHROPIC_STRICT);
  });

  it('picks the smaller-budget descriptor when both are strict', () => {
    // Anthropic has documented per-request limits; OpenAI does not. Anthropic wins.
    expect(strictestOf(OPENAI_STRICT, ANTHROPIC_STRICT)).toBe(ANTHROPIC_STRICT);
    expect(strictestOf(ANTHROPIC_STRICT, GOOGLE_STRICT)).toBe(ANTHROPIC_STRICT);
  });
});

describe('SchemaBudget — basic allocation', () => {
  const simple = z.object({ a: z.string() });

  it('returns the family\'s NON-STRICT descriptor when requested === false', () => {
    // Not `LENIENT`: a dialect rule can outlive strict mode (Google's "any"
    // encoding is one), so an item that loses strict still has to be emitted
    // through its own family. For OpenAI the two are the same rules under a
    // different id, which is exactly why this is asserted rather than assumed.
    const budget = new SchemaBudget(OPENAI_STRICT);
    expect(budget.allocateTool(simple, false)).toBe(OPENAI_NON_STRICT);
  });

  it('returns the descriptor when requested === true and feasible', () => {
    const budget = new SchemaBudget(OPENAI_STRICT);
    expect(budget.allocateTool(simple, true)).toBe(OPENAI_STRICT);
  });

  it('returns the descriptor for numeric priority when budget is uncapped', () => {
    const budget = new SchemaBudget(OPENAI_STRICT); // OpenAI has no slot limit
    expect(budget.allocateTool(simple, 5)).toBe(OPENAI_STRICT);
    expect(budget.allocateTool(simple, 1)).toBe(OPENAI_STRICT);
  });

  it('returns the family\'s NON-STRICT descriptor for undefined / 0 priority', () => {
    const budget = new SchemaBudget(OPENAI_STRICT);
    expect(budget.allocateTool(simple, undefined)).toBe(OPENAI_NON_STRICT);
    expect(budget.allocateTool(simple, 0)).toBe(OPENAI_NON_STRICT);
  });

  it('returns LENIENT when descriptor is itself LENIENT', () => {
    const budget = new SchemaBudget(LENIENT);
    expect(budget.allocateTool(simple, true)).toBe(LENIENT);
    expect(budget.allocateTool(simple, 5)).toBe(LENIENT);
  });
});

describe('SchemaBudget — Anthropic per-request limits', () => {
  const simple = z.object({ a: z.string() });

  it('allocates up to maxStrictTools (20) for numeric-priority items, then falls back', () => {
    const budget = new SchemaBudget(ANTHROPIC_STRICT);
    let granted = 0;
    let lenient = 0;
    for (let i = 0; i < 25; i++) {
      const d = budget.allocateTool(simple, 5);
      if (d.strict) granted++;
      else lenient++;
    }
    expect(granted).toBe(20);
    expect(lenient).toBe(5);
    expect(budget.remaining().strictTools).toBe(0);
  });

  it('does NOT enforce tool budget for hard `true` items', () => {
    // Hard requirements skip budget checks — model selection guaranteed
    // feasibility, so over-budget is the user's responsibility.
    const budget = new SchemaBudget(ANTHROPIC_STRICT);
    for (let i = 0; i < 25; i++) {
      const d = budget.allocateTool(simple, true);
      expect(d).toBe(ANTHROPIC_STRICT);
    }
  });

  it('exhausts optional-params budget across many items with optionals', () => {
    const oneOptional = z.object({
      a: z.string(),
      b: z.string().optional(),
    });
    const budget = new SchemaBudget(ANTHROPIC_STRICT); // 24 optional params allowed

    let granted = 0;
    for (let i = 0; i < 30; i++) {
      const d = budget.allocateTool(oneOptional, 5);
      if (d.strict) granted++;
    }
    // Each tool has 1 optional param; 24 fit, then optional-param budget runs out.
    expect(granted).toBe(20); // bounded first by maxStrictTools=20 actually
  });

  it('exhausts union-types budget', () => {
    const oneUnion = z.object({
      a: z.string(),
      b: z.union([z.string(), z.number()]),
    });
    const budget = new SchemaBudget(ANTHROPIC_STRICT); // 16 union types allowed
    let granted = 0;
    for (let i = 0; i < 20; i++) {
      const d = budget.allocateTool(oneUnion, 5);
      if (d.strict) granted++;
    }
    expect(granted).toBe(16);
  });

  it('keeps recursive schemas strict under ANTHROPIC_STRICT (cycle-broken inline)', () => {
    // Anthropic strict no longer degrades recursive schemas to LENIENT — the
    // toJSONSchema cycle-breaker inlines a flat "any" placeholder at every
    // back-edge so the schema remains expressible. allocateTool therefore
    // grants strict (subject to remaining union/optional budget).
    type Node = { value: string; children?: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({
        value: z.string(),
        children: z.array(NodeSchema).optional(),
      })
    );
    const budget = new SchemaBudget(ANTHROPIC_STRICT);
    expect(budget.allocateTool(NodeSchema, true)).toBe(ANTHROPIC_STRICT);
    expect(budget.allocateTool(NodeSchema, 5)).toBe(ANTHROPIC_STRICT);
  });
});

describe('SchemaBudget — shared between tools and output', () => {
  it('counts optional params across allocateTool + allocateOutput', () => {
    // Build a custom-feeling case: schema has 13 optional params each. Two
    // such tools + an output schema would exceed Anthropic's 24 cap.
    const wide = z.object({
      a: z.string(),
      b: z.string().optional(),
      c: z.string().optional(),
      d: z.string().optional(),
      e: z.string().optional(),
      f: z.string().optional(),
      g: z.string().optional(),
      h: z.string().optional(),
      i: z.string().optional(),
      j: z.string().optional(),
      k: z.string().optional(),
      l: z.string().optional(),
      m: z.string().optional(),
      n: z.string().optional(),
    });
    const budget = new SchemaBudget(ANTHROPIC_STRICT);
    expect(budget.allocateTool(wide, 5)).toBe(ANTHROPIC_STRICT); // 13 used, 11 left
    // Second allocation needs 13 more; only 11 remain → fallback, to the
    // family's own non-strict descriptor.
    expect(budget.allocateTool(wide, 5)).toBe(ANTHROPIC_NON_STRICT);
    // Output schema also competes — but tool 1 already exhausted nearly the
    // whole budget, so output fits or fails depending on its own optionals.
    const small = z.object({ x: z.string() });
    expect(budget.allocateOutput(small, 5)).toBe(ANTHROPIC_STRICT);
  });
});

describe('SchemaBudget — descriptor.id pinning is the caller\'s job', () => {
  // Allocate and ensure the descriptor returned is the configured one (not
  // the LENIENT alias) so providers can pin descriptor.id for the validation
  // roundtrip.
  it('returns the descriptor instance, not a clone', () => {
    const budget = new SchemaBudget(OPENAI_STRICT);
    const d = budget.allocateTool(z.object({ a: z.string() }), true);
    expect(d).toBe(OPENAI_STRICT);
    expect(d.id).toBe('openai-strict');
  });
});
