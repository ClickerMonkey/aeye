/**
 * DIRECTED, domain-specific structural-failure messages end-to-end through the
 * tool report — now produced by the OWNED, zod-free structural parser (the
 * ACTIVE gate) rather than by zod. Zod is only the model-facing wire schema.
 *
 * A single badly-formatted demo query carries one of each failure class:
 *  - `left: "oops"`      → "expected an expression, got a string" (a child slot);
 *  - `op: "equals"`      → "expected a comparison operator: =, <>, …" (an enum);
 *  - `args: "total"`     → "expected named arguments …" (a record);
 *  - `kind: "comparise"` → "unknown expression kind `comparise` — did you mean
 *                           `comparison`?" (a dispatch no-match with a typo'd kind);
 *  - `limit: "three"`    → "expected a number or a param, got a string" (a bound).
 * Plus: an unknown Type name is now a SEMANTIC (validateWalk) rejection — the
 * owned parser accepts any string type (structure only) and `validateQuery`
 * flags the unknown reference — and the owned parser records ONE problem per
 * offending path (no duplicate-path noise to collapse).
 *
 * Each message is asserted to be DIRECTED (domain vocabulary, not Zod types) AND
 * still UNDERLINED at the offending value.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool, QueryToolError, type BuildQueryToolOptions } from '../llm/tool';

const ctx: Context<{}, {}> = {};

/** Parse a (malformed) query and return the thrown `QueryToolError`. */
async function toolError(
  fx: ReturnType<typeof runtimeFixture>,
  query: unknown,
  options: BuildQueryToolOptions = {},
): Promise<QueryToolError> {
  const tool = buildQueryTool(fx.engine, options);
  try {
    await tool.parse(ctx, JSON.stringify({ query }));
  } catch (err) {
    if (err instanceof QueryToolError) return err;
    throw err;
  }
  throw new Error('expected a QueryToolError');
}

/** The message of the single problem at an exact structural path. */
function messageAt(err: QueryToolError, path: (string | number)[]): string {
  const key = JSON.stringify(path);
  const p = err.problems.list.find((q) => JSON.stringify(q.path) === key);
  expect(p, `a problem at ${key}`).toBeDefined();
  return p!.message;
}

/** The caret (underline) line immediately following the line containing `token`. */
function caretUnder(report: string, token: string): { source: string; caret: string } {
  const lines = report.split('\n');
  const i = lines.findIndex((l) => l.includes(token));
  expect(i).toBeGreaterThanOrEqual(0);
  return { source: lines[i]!, caret: lines[i + 1]! };
}

describe('directed schema-failure messages', () => {
  it('renders a domain-specific message for each failure class in one query', async () => {
    const fx = runtimeFixture();
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      fields: [{ expr: { kind: 'aggregate', function: 'sum', args: 'total' } }],
      where: [
        { kind: 'comparison', op: 'equals', left: 'oops', right: ref('user', 'id') },
        { kind: 'comparise', op: '=', left: ref('user', 'id'), right: ref('user', 'id') },
      ],
      limit: 'three',
    };
    const err = await toolError(fx, bad);

    // Each offending value gets its DIRECTED, domain-specific message. Paths are
    // relative to the `query` def (the owned parser renders against it, so there
    // is no leading `query` envelope segment that zod's paths carried).
    expect(messageAt(err, ['where', 0, 'left'])).toBe('expected an expression, got a string');
    expect(messageAt(err, ['where', 0, 'op'])).toBe(
      'expected a comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike',
    );
    expect(messageAt(err, ['fields', 0, 'expr', 'args'])).toBe(
      'expected named arguments, an object of { argName: <expr> }, got a string',
    );
    // The owned parser is NOT capability-gated (structure only), so it offers
    // every REGISTERED expr kind — including the ones the wire schema gates out
    // per capability (output / tabular-function-call / excluded).
    expect(messageAt(err, ['where', 1])).toBe(
      'unknown expression kind `comparise` — did you mean `comparison`? (available: ' +
        'literal, output, field-ref, param, binary, unary, comparison, logical, in, ' +
        'between, is-null, exists, array-op, case, aggregate, window, function-call, ' +
        'tabular-function-call, semantic, text-search, text-score, filters, subquery, excluded)',
    );
    expect(messageAt(err, ['limit'])).toBe('expected a number or a param, got a string');

    // None of Zod's generic type vocabulary leaks into these messages.
    expect(err.report).not.toContain('expected object, received string');
    expect(err.report).not.toContain('does not match any of the allowed shapes');
  });

  it('surfaces MULTIPLE structural problems in ONE pass, each underlined + directed', async () => {
    const fx = runtimeFixture();
    // Structural errors spread across FOUR clauses — the owned parser is the
    // ACTIVE gate now and ACCUMULATES them all in a single pass (it does not
    // stop at the first), rendering ONE report that underlines every offender.
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      fields: [123], // fields.0: not a select field object
      where: [{ kind: 'comparison', op: 'equals', left: 'oops', right: ref('user', 'id') }],
      groupBy: [true], // groupBy.0: not an expr
      limit: 'three', // limit: not a number|param
    };
    const err = await toolError(fx, bad);

    // Every offending path is reported (accumulation across clauses), each with
    // its DIRECTED, domain-specific message.
    expect(messageAt(err, ['fields', 0])).toContain('a select field');
    expect(messageAt(err, ['where', 0, 'op'])).toContain('a comparison operator');
    expect(messageAt(err, ['where', 0, 'left'])).toBe('expected an expression, got a string');
    expect(messageAt(err, ['groupBy', 0])).toBe('expected an expression, got a boolean');
    expect(messageAt(err, ['limit'])).toContain('a number or a param');
    expect(err.problems.list.length).toBeGreaterThanOrEqual(5);

    // Each offending token is UNDERLINED in the ONE rendered report.
    for (const token of ['123', '"equals"', '"oops"', 'true', '"three"']) {
      const { source, caret } = caretUnder(err.report, token);
      expect(caret).toContain('^');
      expect(caret.indexOf('^')).toBe(source.indexOf(token));
    }
  });

  it('keeps the DIRECTED message UNDERLINED at the offending value (owned-parser intact)', async () => {
    const fx = runtimeFixture();
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      fields: [{ expr: ref('user', 'id') }],
      where: [{ kind: 'comparison', op: '=', left: 'oops', right: ref('user', 'id') }],
    };
    const err = await toolError(fx, bad);

    expect(err.report).toContain('expected an expression');
    const { source, caret } = caretUnder(err.report, '"left": "oops"');
    // `^^^^^^` (6 carets, the quoted token) sits exactly under `"oops"`.
    expect(caret.slice(caret.indexOf('^'))).toBe('^'.repeat('"oops"'.length));
    expect(caret.indexOf('^')).toBe(source.indexOf('"oops"'));
  });

  it('rejects an unknown Type name as a SEMANTIC (validateWalk) problem', async () => {
    const fx = runtimeFixture();
    // The owned parser accepts ANY string type (capability / depth is a
    // wire-schema concern), so `ghost` is structurally fine; referencing it
    // makes `validateQuery` flag the unknown Type/field with a directed,
    // `didYouMean`-style semantic message, still underlined at the offender.
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'ghost' },
      fields: [{ expr: ref('ghost', 'id') }],
    };
    // A depth that would have enumerated Type-name positions in the WIRE schema
    // no longer gates the owned structural parse — the rejection is semantic.
    const err = await toolError(fx, bad, { depth: 'paired' });
    expect(messageAt(err, ['fields', 0, 'expr'])).toContain("has no field 'id'");
    const { source, caret } = caretUnder(err.report, '"expr": {');
    expect(caret.indexOf('^')).toBe(source.indexOf('{'));
  });

  it('records ONE problem per offending path (no duplicate-path noise)', async () => {
    const fx = runtimeFixture();
    // A CTE entry with a non-string `name`: the owned parser records exactly one
    // problem at `[.., name]` (its `str` shape), plus the entry's own missing
    // `query` — no undiscriminated-union duplication to collapse.
    const bad = {
      kind: 'cte',
      ctes: [{ name: 5 }],
      final: { kind: 'select', from: { kind: 'type', type: 'user' }, fields: [] },
    };
    const err = await toolError(fx, bad);
    const nameProblems = err.problems.list.filter(
      (p) => JSON.stringify(p.path) === JSON.stringify(['ctes', 0, 'name']),
    );
    expect(nameProblems.length).toBe(1);
    expect(nameProblems[0]!.message).toBe('expected a field name, got a number');
  });
});
