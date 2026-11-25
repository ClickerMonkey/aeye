/**
 * Part B — the query grammar is factored into shared, named `$defs`.
 *
 * Two guarantees are pinned here, both measured over the bundled EXAMPLE fixture
 * (user / order / product, 100+ builtin functions):
 *
 *  1. SIZE — the JSON Schema a model is sent stays BELOW a threshold set from
 *     the measured size, so a regression that re-inlines the shared fragments
 *     (field-name enums `Fields_<Type>`, typed function args `Args…`, `param`,
 *     `Limit`) is caught. The shared `$defs` are asserted present by name.
 *
 *  2. GOLDEN accept/reject — a fixed set of ~10 valid + ~10 invalid query defs
 *     must get the SAME accept/reject from the schema and the full tool; the
 *     model's message for an invalid one is @aeye/schema's (its own JSON with a
 *     marker, under the size cap), and the standalone parser's directed text
 *     (`parseQueryTool`) is unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { LENIENT, OPENAI_STRICT, SchemaParseError } from '@aeye/schema';
import { createExampleFixture } from '../../examples/schema';
import { querySchema } from '../llm/schemas';
import { buildQueryTool, parseQueryTool, QueryToolError } from '../llm/tool';
import type { QueryDef } from '../schema';
import { accepts } from './_utils';

const ctx: Context<{}, {}> = {};

describe('Part B — shared `$defs` factoring: size', () => {
  it('paired + open schemas stay factored (below the re-inline threshold)', () => {
    const { engine } = createExampleFixture();
    const sent = (depth: 'open' | 'paired', profile = LENIENT) => {
      const s = querySchema(engine, { depth });
      return ('bind' in s ? s.bind() : s).render(profile).jsonSchema as { $defs?: Record<string, unknown> };
    };
    // Measured: open 16.4 KB (LENIENT) / 22.5 KB (OpenAI strict); paired 78 KB / 96 KB.
    expect(JSON.stringify(sent('open')).length).toBeLessThan(20000);
    expect(JSON.stringify(sent('open', OPENAI_STRICT)).length).toBeLessThan(27000);
    expect(JSON.stringify(sent('paired')).length).toBeLessThan(90000);
    expect(JSON.stringify(sent('paired', OPENAI_STRICT)).length).toBeLessThan(110000);

    const defs = Object.keys(sent('paired').$defs ?? {});
    expect(defs).toContain('Fields_user');
    expect(defs.some((d) => d.startsWith('Args'))).toBe(true);
    expect(defs).toContain('param');
    expect(defs).toContain('Limit');
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
  ['relation join', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], from: { kind: 'type', type: 'order' }, joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'buyer' } }] }],
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
  // The owned parser accepts any string field (structure only); an unknown field
  // is a SEMANTIC (validateWalk) rejection with the directed, didYouMean message.
  ['unknown field', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'ghost' } }], from: { kind: 'type', type: 'user' } }, "has no field 'ghost'"],
  ['typo expr kind', { kind: 'select', fields: [{ expr: { kind: 'comparise', op: '=', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } } }], from: { kind: 'type', type: 'user' } }, 'unknown expression kind `comparise` — did you mean `comparison`?'],
  ['bad comparison op', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, where: [{ kind: 'comparison', op: 'equals', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } }] }, 'expected a comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike'],
  ['expr got string', { kind: 'select', fields: [{ expr: { kind: 'comparison', op: '=', left: 'oops', right: { kind: 'literal', value: 1 } } }], from: { kind: 'type', type: 'user' } }, 'expected an expression'],
  ['unknown type name', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'ghost', field: 'id' } }], from: { kind: 'type', type: 'ghost' } }, null],
  ['unknown function', { kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'nope', args: { x: { kind: 'literal', value: 1 } } } }], from: { kind: 'type', type: 'user' } }, null],
  ['bad limit', { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, limit: 'three' }, 'expected a number or a param'],
  ['missing fields', { kind: 'select', from: { kind: 'type', type: 'user' } }, null],
  // The owned parser lists the available kinds in registration order.
  ['unknown query kind', { kind: 'frobnicate' }, 'unknown query kind `frobnicate` (available: select, insert, update, delete, expr, cte, union, intersect, except)'],
  ['undeclared fn arg', { kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'lower', args: { wrong: { kind: 'field-ref', source: 'user', field: 'name' } } } }], from: { kind: 'type', type: 'user' } }, null],
];

describe('Part B — golden accept/reject', () => {
  it('has ~10 valid + ~10 invalid fixed cases', () => {
    expect(VALID.length).toBe(10);
    expect(INVALID.length).toBe(10);
  });

  it('accepts every valid query (schema + full validation)', async () => {
    const { engine } = createExampleFixture();
    const schema = querySchema(engine, { depth: 'paired' });
    const tool = buildQueryTool(engine, { depth: 'paired' });
    for (const [label, query] of VALID) {
      expect(accepts(schema, { query }), label).toBe(true);
      const parsed = await tool.parse(ctx, JSON.stringify({ query }));
      expect(parsed, label).toBeTruthy();
    }
  });

  it('rejects every invalid query; the model is told in the schema format; the directed text is unchanged', { timeout: 30000 }, async () => {
    const { engine } = createExampleFixture();
    const schema = querySchema(engine, { depth: 'paired' });
    const tool = buildQueryTool(engine, { depth: 'paired' });
    for (const [label, query, message] of INVALID) {
      expect(accepts(schema, { query }), label).toBe(false);
      const err = await tool.parse(ctx, JSON.stringify({ query })).then(() => undefined, (e: unknown) => e);
      expect(err, label).toBeInstanceOf(SchemaParseError);
      const text = (err as SchemaParseError).message;
      expect(text.length, label).toBeLessThanOrEqual(2000);
      expect(text, label).toContain('^');
      const own = parseQueryTool(engine, { query }, { depth: 'paired' });
      expect(own, label).toBeInstanceOf(QueryToolError);
      if (own instanceof QueryToolError && message !== null) {
        expect(own.report, label).toContain(message);
      }
    }
  });
});
