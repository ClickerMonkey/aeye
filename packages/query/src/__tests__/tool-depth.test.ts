/**
 * The LLM tooling (`buildQueryTool` / `querySchema`) THREADS `depth` +
 * `functions` straight through to `buildSchemas`, and `buildQueryTool`'s
 * `instructions` reflect the active depth. These assert that the depth /
 * selection actually reach the generated schema (not just the options bag).
 */
import { describe, it, expect } from 'vitest';
import { buildQueryTool } from '../llm/tool';
import { querySchema, depthInstructions } from '../llm/schemas';
import type { SelectDef, ExprDef } from '../schema';
import { fixture } from './_utils';

/** Wrap a field-expression in a minimal SELECT over `user`. */
function selectOf(expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr }], from: { kind: 'type', type: 'user' } };
}

describe('buildQueryTool — depth threading', () => {
  it("depth:'paired' makes the tool schema reject a cross-type field-ref", async () => {
    const fx = fixture();
    const tool = buildQueryTool(fx.engine, { depth: 'paired' });
    // `total` is an `order` field; pairing it with a `user` source is rejected.
    const bad = tool.schema.safeParse({
      query: selectOf({ kind: 'field-ref', source: 'user', field: 'total' }),
    });
    expect(bad.success).toBe(false);
    // The correct pairing validates.
    const good = tool.schema.safeParse({
      query: selectOf({ kind: 'field-ref', source: 'user', field: 'name' }),
    });
    expect(good.success).toBe(true);
  });

  it("instructions reflect the active depth (paired note present, open empty)", () => {
    const fx = fixture();
    const paired = buildQueryTool(fx.engine, { depth: 'paired' });
    expect(paired.instructions).toContain('registered Type names');
    expect(paired.instructions).toContain('Schema constraints:');

    const open = buildQueryTool(fx.engine, { depth: 'open' });
    expect(open.instructions).not.toContain('Schema constraints:');
    // `depthInstructions` itself is empty in fully-open mode.
    expect(depthInstructions(fx.engine, { depth: 'open' })).toBe('');
  });
});

describe('querySchema — function selection threading', () => {
  it("rejects an out-of-selection function name (names depth + selector)", () => {
    const fx = fixture();
    const schema = querySchema(fx.engine, {
      depth: { functions: 'names' },
      functions: { scalar: ['upper'] },
    });
    // `upper` is selected ⇒ accepted.
    const good = schema.safeParse({
      query: selectOf({
        kind: 'function-call',
        function: 'upper',
        args: { value: { kind: 'field-ref', source: 'user', field: 'name' } },
      }),
    });
    expect(good.success).toBe(true);
    // `lower` is a real function but NOT selected ⇒ rejected.
    const bad = schema.safeParse({
      query: selectOf({
        kind: 'function-call',
        function: 'lower',
        args: { value: { kind: 'field-ref', source: 'user', field: 'name' } },
      }),
    });
    expect(bad.success).toBe(false);
  });

  it("depth:'paired' typed args reject an unknown argument name", () => {
    const fx = fixture();
    const schema = querySchema(fx.engine, { depth: 'paired' });
    const bad = schema.safeParse({
      query: selectOf({
        kind: 'function-call',
        function: 'upper',
        args: { wrong: { kind: 'literal', value: 'x' } },
      }),
    });
    expect(bad.success).toBe(false);
  });
});
