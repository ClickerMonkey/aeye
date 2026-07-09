/**
 * Coverage: the STANDALONE parse entries `parseQueryTool` / `parseQueryRequest`
 * — the same parse+validate pipeline `buildQueryTool`'s custom `parse` runs, but
 * WITHOUT building a Tool. They operate on the CONCEPTUAL `{ query: … }` value
 * (as core hands the custom parse hook post-`decodeWire`, and as a directly
 * parsed CLI/file def already is), so no wire schema is needed for parsing.
 *
 * These assert: (a) a valid def → a runnable `Query` IDENTICAL to
 * `buildQueryTool(engine).parse`'s output; (b) a malformed def → a
 * `QueryToolError` whose `report` is the underlined, aid-directed diagnostics;
 * (c) the missing-`query` envelope + prose-string paths surface the right
 * problem; (d) `parseQueryRequest` exposes the detailed `{ query, problems,
 * report }`.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool, parseQueryTool, parseQueryRequest, QueryToolError } from '../llm/tool';
import { Query } from '../queries/query';
import type { SelectDef } from '../schema';

const validSelect: SelectDef = {
  kind: 'select',
  fields: [{ expr: ref('user', 'id'), as: 'id' }],
  from: { kind: 'type', type: 'user' },
  order: [{ expr: ref('user', 'id'), dir: 'asc' }],
};

const badSelect: SelectDef = {
  kind: 'select',
  fields: [{ expr: ref('user', 'ghost') }],
  from: { kind: 'type', type: 'user' },
};

/** A minimal, cast-free context for `tool.parse` (the equivalence check). */
const ctx: Context<{}, {}> = {};

describe('parseQueryTool / parseQueryRequest (standalone)', () => {
  it('parses a valid { query } envelope into a runnable Query', () => {
    const fx = runtimeFixture();
    const result = parseQueryTool(fx.engine, { query: validSelect });
    expect(result).toBeInstanceOf(Query);
    if (result instanceof Query) {
      // The conceptual def round-trips through the built query unchanged.
      expect(result.toJSON()).toEqual(validSelect);
    }
  });

  it('is IDENTICAL to buildQueryTool(engine).parse for the same input', async () => {
    const fx = runtimeFixture();
    const built = await buildQueryTool(fx.engine).parse(ctx, JSON.stringify({ query: validSelect }));
    const standalone = parseQueryTool(fx.engine, { query: validSelect });
    expect(standalone).toBeInstanceOf(Query);
    if (standalone instanceof Query) {
      expect(standalone.toJSON()).toEqual(built.toJSON());
    }
  });

  it('returns a QueryToolError with an underlined, aid-directed report on a malformed def', () => {
    const fx = runtimeFixture();
    const result = parseQueryTool(fx.engine, { query: badSelect });
    expect(result).toBeInstanceOf(QueryToolError);
    if (result instanceof QueryToolError) {
      expect(result.problems.hasErrors).toBe(true);
      expect(result.report).toContain("has no field 'ghost'");
      expect(result.report).toContain('^^^');
      expect(result.message).toBe(result.report);
    }
  });

  it('the malformed-def error MATCHES buildQueryTool(engine).parse', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    let toolErr: QueryToolError | null = null;
    try {
      await tool.parse(ctx, JSON.stringify({ query: badSelect }));
    } catch (err) {
      if (err instanceof QueryToolError) toolErr = err;
    }
    const standalone = parseQueryTool(fx.engine, { query: badSelect });
    expect(standalone).toBeInstanceOf(QueryToolError);
    if (standalone instanceof QueryToolError && toolErr) {
      expect(standalone.report).toBe(toolErr.report);
      expect(standalone.problems.list.map((p) => p.code)).toEqual(
        toolErr.problems.list.map((p) => p.code),
      );
    }
  });

  it('surfaces the missing-`query` envelope problem', () => {
    const fx = runtimeFixture();
    const result = parseQueryTool(fx.engine, { notQuery: 1 });
    expect(result).toBeInstanceOf(QueryToolError);
    if (result instanceof QueryToolError) {
      const p = result.problems.list[0];
      expect(p?.code).toBe('shape.required');
      expect(p?.message).toBe('missing required field `query`');
    }
  });

  it('rejects prose input (string `query`) in structured mode', () => {
    const fx = runtimeFixture();
    const result = parseQueryTool(fx.engine, { query: 'just prose' });
    expect(result).toBeInstanceOf(QueryToolError);
    if (result instanceof QueryToolError) {
      expect(result.problems.list.some((p) => p.code === 'query.needs-structuring')).toBe(true);
    }
  });

  it('reports needs-structuring in string-fallback mode (max 0)', () => {
    const fx = runtimeFixture();
    // `max: 0` → too many Types → string schema → prose path even for a def.
    const result = parseQueryTool(fx.engine, { query: validSelect }, { max: 0 });
    expect(result).toBeInstanceOf(QueryToolError);
    if (result instanceof QueryToolError) {
      expect(result.problems.list.some((p) => p.code === 'query.needs-structuring')).toBe(true);
    }
  });

  it('parseQueryRequest exposes { query, problems, report } (clean)', () => {
    const fx = runtimeFixture();
    // Pass explicit `types` to exercise the `options.types ?? …` left arm.
    const { query, problems, report } = parseQueryRequest(fx.engine, { query: validSelect }, {
      types: fx.engine.registry.typeList(),
    });
    expect(query).toBeInstanceOf(Query);
    expect(problems.hasErrors).toBe(false);
    expect(report).toBe('');
  });

  it('parseQueryRequest exposes { query, problems, report } — semantic problems keep the built query', () => {
    const fx = runtimeFixture();
    // No `types` option → the `options.types ?? engine.registry.typeList()` default arm.
    // A bad field-ref is a SEMANTIC error: the def parses structurally (so the
    // built `Query` is non-null), but `validateQuery` accumulates problems.
    const { query, problems, report } = parseQueryRequest(fx.engine, { query: badSelect });
    expect(query).toBeInstanceOf(Query);
    expect(problems.hasErrors).toBe(true);
    expect(report).not.toBe('');
  });

  it('parseQueryRequest returns a null query on a STRUCTURAL failure', () => {
    const fx = runtimeFixture();
    // Missing required `fields` / `from` is a STRUCTURAL failure: the owned
    // parser cannot build a `Query`, so `query` is null.
    const { query, problems, report } = parseQueryRequest(fx.engine, { query: { kind: 'select' } });
    expect(query).toBeNull();
    expect(problems.hasErrors).toBe(true);
    expect(report).not.toBe('');
  });
});
