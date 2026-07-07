/**
 * DIRECTED, domain-specific schema-failure messages end-to-end through the tool
 * report (Phase B on top of Phase A's underlining).
 *
 * A single badly-formatted demo query carries one of each failure class:
 *  - `left: "oops"`      → "expected an expression" (a union no-match);
 *  - `op: "equals"`      → "expected a comparison operator: =, <>, …" (an enum);
 *  - `args: "total"`     → "expected named arguments …" (a record);
 *  - `kind: "comparise"` → "unknown expression kind `comparise` — did you mean
 *                           `comparison`?" (a union no-match with a typo'd kind);
 *  - `limit: "three"`    → "expected a number or a param" (a number|param union).
 * Plus: an unknown Type name under an ENUMERATED depth → "expected a registered
 * Type name", and a duplicate-path collapse (a CTE with a non-string `name`).
 *
 * Each message is asserted to be DIRECTED (domain vocabulary, not Zod types) AND
 * still UNDERLINED at the offending value (Phase A intact).
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

    // Each offending value gets its DIRECTED, domain-specific message.
    expect(messageAt(err, ['query', 'where', 0, 'left'])).toBe('expected an expression');
    expect(messageAt(err, ['query', 'where', 0, 'op'])).toBe(
      'expected a comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike',
    );
    expect(messageAt(err, ['query', 'fields', 0, 'expr', 'args'])).toBe(
      'expected named arguments, an object of { argName: <expr> }, got a string',
    );
    expect(messageAt(err, ['query', 'where', 1])).toBe(
      'unknown expression kind `comparise` — did you mean `comparison`? (available: ' +
        'literal, field-ref, relation-path, param, binary, unary, comparison, logical, in, ' +
        'between, is-null, exists, array-op, case, aggregate, window, function-call, semantic, ' +
        'text-search, text-score, filters, subquery)',
    );
    expect(messageAt(err, ['query', 'limit'])).toBe('expected a number or a param');

    // None of Zod's generic type vocabulary leaks into these messages.
    expect(err.report).not.toContain('expected object, received string');
    expect(err.report).not.toContain('does not match any of the allowed shapes');
  });

  it('keeps the DIRECTED message UNDERLINED at the offending value (Phase A intact)', async () => {
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

  it('directs an unknown Type name to a registered-Type-name message (enum depth)', async () => {
    const fx = runtimeFixture();
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'ghost' },
      fields: [],
    };
    // `depth: 'paired'` enumerates Type-name positions, so `ghost` is rejected.
    const err = await toolError(fx, bad, { depth: 'paired' });
    expect(messageAt(err, ['query', 'from', 'type'])).toBe('expected a registered Type name');
    const { source, caret } = caretUnder(err.report, '"type": "ghost"');
    expect(caret.indexOf('^')).toBe(source.indexOf('"ghost"'));
  });

  it('collapses duplicate offending paths from an undiscriminated union', async () => {
    const fx = runtimeFixture();
    // A CTE entry with a non-string `name`: BOTH structurally-discriminated
    // CteEntry shapes engage at `[.., name]`, so the dedup keeps ONE problem.
    const bad = {
      kind: 'cte',
      ctes: [{ name: 5 }],
      final: { kind: 'select', from: { kind: 'type', type: 'user' }, fields: [] },
    };
    const err = await toolError(fx, bad);
    const nameProblems = err.problems.list.filter(
      (p) => JSON.stringify(p.path) === JSON.stringify(['query', 'ctes', 0, 'name']),
    );
    expect(nameProblems.length).toBe(1);
  });
});
