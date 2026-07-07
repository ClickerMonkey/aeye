/**
 * Part B — the tool-call JSON-Schema is factored into shared, aid-named `$defs`.
 *
 * Two guarantees are pinned here, both measured over the bundled EXAMPLE fixture
 * (user / order / product, 100+ builtin functions):
 *
 *  1. SIZE — `z.toJSONSchema` of the generated schema is BELOW a threshold set
 *     from the measured post-factoring size, so a regression that re-inlines the
 *     shared fragments (field-name enums, `param`, typed function args) — which
 *     would bloat the `paired` schema back past ~105 KB — is caught. The shared
 *     `$defs` (`Fields_*`, `Args*`, `param`, `Limit`) are asserted present.
 *
 *  2. GOLDEN accept/reject + directed-message INVARIANCE — a fixed set of ~10
 *     valid + ~10 invalid query defs must parse to the SAME accept/reject AND
 *     (for the invalids) the SAME aid-directed error text. Factoring changes the
 *     schema's STRUCTURE / SIZE only; its ACCEPTANCE and diagnostics are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Context } from '@aeye/core';
import { createExampleFixture } from '../../examples/schema';
import { querySchema } from '../llm/schemas';
import { buildQueryTool, QueryToolError } from '../llm/tool';
import type { QueryDef } from '../schema';

const ctx: Context<{}, {}> = {};

describe('Part B — shared-`$def` factoring: size', () => {
  it('paired + open schemas stay factored (below the re-inline threshold)', () => {
    const { engine } = createExampleFixture();
    const open = z.toJSONSchema(querySchema(engine, { depth: 'open' }), { unrepresentable: 'any' });
    const paired = z.toJSONSchema(querySchema(engine, { depth: 'paired' }), { unrepresentable: 'any' });
    const openLen = JSON.stringify(open).length;
    const pairedLen = JSON.stringify(paired).length;

    // Post-factoring: open ~20.2 KB (was ~21.3 KB), paired ~95.5 KB (was
    // ~105.6 KB). A regression that re-inlines the shared fragments jumps back
    // past these bounds.
    expect(openLen).toBeLessThan(21000);
    expect(pairedLen).toBeLessThan(100000);

    // The largest repeated fragments are factored into shared, readably-named
    // `$defs` (field-name enums, typed args, `param`, `Limit`).
    const defs = Object.keys(paired.$defs ?? {});
    expect(defs.some((d) => d.startsWith('Fields_'))).toBe(true);
    expect(defs.some((d) => d.startsWith('Args'))).toBe(true);
    expect(defs.some((d) => d === 'param' || d.startsWith('param_'))).toBe(true);
    expect(defs.some((d) => d === 'Limit' || d.startsWith('Limit_'))).toBe(true);
    // Many distinct fragments share via `$ref` — far more `$defs` than the two
    // (`__schema0/1`) the unfactored schema emitted.
    expect(defs.length).toBeGreaterThan(20);
  });
});

/** A valid query def (accepted by the schema AND full engine validation). */
const VALID: ReadonlyArray<readonly [string, QueryDef]> = [
  ['select', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } }],
  ['comparison', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }], from: { kind: 'type', type: 'user' }, where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 30 } }] }],
  ['typed scalar fn', { kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'lower', args: { value: { kind: 'field-ref', source: 'user', field: 'name' } } } }], from: { kind: 'type', type: 'user' } }],
  ['aggregate count(*)', { kind: 'select', fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} } }], from: { kind: 'type', type: 'user' } }],
  ['param limit', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, limit: { kind: 'param', name: 'n' } }],
  ['text-search', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, where: [{ kind: 'text-search', source: 'user', field: 'email', query: 'ada' }] }],
  ['order-by', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }] }],
  ['relation join', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], from: { kind: 'type', type: 'order' }, joins: [{ on: { source: 'order', field: 'userId' } }] }],
  ['expr query', { kind: 'expr', expr: { kind: 'literal', value: 1 } }],
  ['set operation', { kind: 'union', left: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } }, right: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } } }],
];

/**
 * An invalid query def (typed `object` — these are deliberately malformed, so
 * they never conform to `QueryDef`, and `safeParse` / `JSON.stringify` accept
 * any object without a cast) + a directed-message substring the report MUST
 * contain (or `null` to only assert rejection when the message is union-noisy).
 */
const INVALID: ReadonlyArray<readonly [string, object, string | null]> = [
  ['unknown field', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'ghost' } }], from: { kind: 'type', type: 'user' } }, 'expected a field name'],
  ['typo expr kind', { kind: 'select', fields: [{ expr: { kind: 'comparise', op: '=', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } } }], from: { kind: 'type', type: 'user' } }, 'unknown expression kind `comparise` — did you mean `comparison`?'],
  ['bad comparison op', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, where: [{ kind: 'comparison', op: 'equals', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } }] }, 'expected a comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike'],
  ['expr got string', { kind: 'select', fields: [{ expr: { kind: 'comparison', op: '=', left: 'oops', right: { kind: 'literal', value: 1 } } }], from: { kind: 'type', type: 'user' } }, 'expected an expression'],
  ['unknown type name', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'ghost', field: 'id' } }], from: { kind: 'type', type: 'ghost' } }, null],
  ['unknown function', { kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'nope', args: { x: { kind: 'literal', value: 1 } } } }], from: { kind: 'type', type: 'user' } }, null],
  ['bad limit', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, limit: 'three' }, 'expected a number or a param'],
  ['missing fields', { kind: 'select', from: { kind: 'type', type: 'user' } }, null],
  ['unknown query kind', { kind: 'frobnicate' }, 'unknown query kind `frobnicate` (available: select, insert, update, delete, union, intersect, except, cte, expr)'],
  ['undeclared fn arg', { kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'lower', args: { wrong: { kind: 'field-ref', source: 'user', field: 'name' } } } }], from: { kind: 'type', type: 'user' } }, null],
];

describe('Part B — golden accept/reject + directed-message invariance', () => {
  it('has ~10 valid + ~10 invalid fixed cases', () => {
    expect(VALID.length).toBe(10);
    expect(INVALID.length).toBe(10);
  });

  it('accepts every valid query (schema + full validation)', async () => {
    const { engine } = createExampleFixture();
    const schema = querySchema(engine, { depth: 'paired' });
    const tool = buildQueryTool(engine, { depth: 'paired' });
    for (const [label, query] of VALID) {
      expect(schema.safeParse({ query }).success, `schema should accept: ${label}`).toBe(true);
      // Full pipeline: parse returns the built Query (never a QueryToolError).
      const parsed = await tool.parse(ctx, JSON.stringify({ query }));
      expect(parsed, `full validation should accept: ${label}`).not.toBeInstanceOf(QueryToolError);
    }
  });

  // The `paired` schema is a large union; exhaustively rejecting the invalids
  // (which explore every branch) is inherently slow, so allow extra time.
  it('rejects every invalid query with the same directed message', { timeout: 30000 }, async () => {
    const { engine } = createExampleFixture();
    const schema = querySchema(engine, { depth: 'paired' });
    const tool = buildQueryTool(engine, { depth: 'paired' });
    for (const [label, query, message] of INVALID) {
      expect(schema.safeParse({ query }).success, `schema should reject: ${label}`).toBe(false);
      try {
        await tool.parse(ctx, JSON.stringify({ query }));
        expect.unreachable(`parse should have thrown for: ${label}`);
      } catch (err) {
        expect(err, label).toBeInstanceOf(QueryToolError);
        if (err instanceof QueryToolError && message !== null) {
          expect(err.report, `directed message for: ${label}`).toContain(message);
        }
      }
    }
  });
});
