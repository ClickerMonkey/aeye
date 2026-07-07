/**
 * `QueryToolError.report` renders problems as compiler-style, UNDERLINED
 * diagnostics over the model's own query JSON — closing the "no spans" gap.
 *
 * Coverage of the underlining pipeline end-to-end:
 *  - a STRUCTURAL (zod) failure at a nested path (a comparison with a string
 *    `left`) underlines the offending value in the rendered JSON;
 *  - a SEMANTIC (validateWalk) failure (an unknown field) underlines the
 *    offending field-ref;
 *  - a problem whose path resolves to NO JSON node degrades to a graceful
 *    fallback line (no crash) — asserted directly against `Code.fromJson`.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool, QueryToolError } from '../llm/tool';
import { Code } from '../code';
import { Problems } from '../problem';

const ctx: Context<{}, {}> = {};

/** Parse a (malformed) query and return the thrown `QueryToolError`. */
async function toolError(fx: ReturnType<typeof runtimeFixture>, query: unknown): Promise<QueryToolError> {
  const tool = buildQueryTool(fx.engine);
  try {
    await tool.parse(ctx, JSON.stringify({ query }));
  } catch (err) {
    if (err instanceof QueryToolError) return err;
    throw err;
  }
  throw new Error('expected a QueryToolError');
}

/** The caret (underline) line immediately following the source line that contains `token`. */
function caretLineUnder(report: string, token: string): { source: string; caret: string } {
  const lines = report.split('\n');
  const i = lines.findIndex((l) => l.includes(token));
  expect(i).toBeGreaterThanOrEqual(0);
  return { source: lines[i]!, caret: lines[i + 1]! };
}

describe('QueryToolError report underlining', () => {
  it('underlines a STRUCTURAL zod failure at the offending nested value', async () => {
    const fx = runtimeFixture();
    // A comparison whose `left` is a string instead of an expr object.
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      fields: [{ expr: ref('user', 'id') }],
      where: [{ kind: 'comparison', op: '=', left: 'oops', right: ref('user', 'id') }],
    };
    const err = await toolError(fx, bad);

    // Exactly one, isolated problem — the union noise is collapsed.
    expect(err.problems.list.some((p) => p.code === 'schema.invalid')).toBe(true);
    const zodProblem = err.problems.list.find((p) => p.code === 'schema.invalid')!;
    expect(zodProblem.path).toEqual(['query', 'where', 0, 'left']);

    // The report shows the JSON and underlines the `"oops"` token precisely.
    expect(err.report).toContain('"left": "oops"');
    expect(err.report).toContain('Invalid input: expected object, received string');
    const { source, caret } = caretLineUnder(err.report, '"left": "oops"');
    // `^^^^^^` (6 carets, the quoted token) sits exactly under `"oops"`.
    expect(caret.slice(caret.indexOf('^'))).toBe('^'.repeat('"oops"'.length));
    expect(caret.indexOf('^')).toBe(source.indexOf('"oops"'));
  });

  it('underlines a SEMANTIC validateWalk failure at the offending field-ref', async () => {
    const fx = runtimeFixture();
    const bad = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      fields: [{ expr: ref('user', 'ghost') }],
    };
    const err = await toolError(fx, bad);

    const semantic = err.problems.list.find((p) => p.code === 'ref.unknown-field')!;
    expect(semantic).toBeDefined();
    expect(semantic.path).toEqual(['fields', 0, 'expr']);

    // The field-ref object is underlined, with the human message shown.
    expect(err.report).toContain("has no field 'ghost'");
    expect(err.report).toContain('^');
    // The underline anchors on the `expr` object's value (its opening brace).
    const { source, caret } = caretLineUnder(err.report, '"expr": {');
    expect(caret.indexOf('^')).toBe(source.indexOf('{'));
  });

  it('degrades gracefully (no crash) when a path resolves to no exact JSON node', () => {
    // `Code.fromJson` always registers a ROOT span, so a deep unmatched path
    // resolves to its nearest existing ancestor (here, the root) — it underlines
    // that rather than crashing.
    const codeValue = Code.fromJson({ kind: 'select', from: { kind: 'type', type: 'user' } });
    const problems = new Problems();
    problems.at(['does', 'not', 'exist'], () => problems.error('x.y', 'no node here'));
    const out = codeValue.formatProblems(problems);
    expect(out).toContain('no node here');
    expect(out).toContain('^'); // degraded to the ancestor underline, not a crash

    // The true span-less fallback line (used when a Code has NO covering span at
    // all) is still available — no root span here, so the path cannot resolve.
    const spanless = new Code('field-ref', [{ start: 0, end: 9, path: ['other'] }]);
    const fb = new Problems();
    fb.at(['unmatched'], () => fb.error('x.y', 'no span for this'));
    const fbOut = spanless.formatProblems(fb);
    expect(fbOut).toContain('no span for this');
    expect(fbOut).toContain('@ unmatched');
    expect(fbOut).not.toContain('^');
  });

  it('reports a fully bogus query kind as a whole-value mismatch', async () => {
    const fx = runtimeFixture();
    const err = await toolError(fx, { kind: 'not-a-real-kind' });
    // No branch matched ⇒ the synthetic "does not match any shape" leaf.
    expect(
      err.problems.list.some((p) => p.message.includes('does not match any of the allowed shapes')),
    ).toBe(true);
    expect(err.report).not.toBe('');
  });
});
