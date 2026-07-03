/**
 * Coverage: buildQueryTool — the core `Tool` surface across descriptor
 * metadata, valid/run, schema errors, validation errors, string-fallback, and
 * prose input. `tool.parse` returns the built `Query` (or THROWS a
 * `QueryToolError`); `tool.run` executes the validated query.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool, QueryToolError } from '../llm/tool';
import type { SelectDef } from '../schema';

const validSelect: SelectDef = {
  kind: 'select',
  fields: [{ expr: ref('user', 'id'), as: 'id' }],
  from: { kind: 'type', type: 'user' },
  order: [{ expr: ref('user', 'id'), dir: 'asc' }],
};

/** A minimal, cast-free context for `tool.parse` / `tool.run`. */
const ctx: Context<{}, {}> = {};

describe('buildQueryTool', () => {
  it('descriptor carries name/description/instructions/schema', () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine, { name: 'q', description: 'D' });
    expect(tool.name).toBe('q');
    expect(tool.description).toBe('D');
    expect(tool.input.instructions ?? '').toContain('Types');
    expect(tool.input.schema).toBeTruthy();
    // Default name/description.
    const dflt = buildQueryTool(fx.engine);
    expect(dflt.name).toBe('query');
    expect(dflt.description).toContain('structured query');
  });

  it('parses + runs a valid structured query', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    const query = await tool.parse(ctx, JSON.stringify({ query: validSelect }));
    const result = await tool.run(query, ctx);
    expect(result.rows.length).toBe(3);
  });

  it('throws a QueryToolError on validation errors (and does not run)', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    const bad: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'ghost') }],
      from: { kind: 'type', type: 'user' },
    };
    await expect(tool.parse(ctx, JSON.stringify({ query: bad }))).rejects.toBeInstanceOf(QueryToolError);
    try {
      await tool.parse(ctx, JSON.stringify({ query: bad }));
      expect.unreachable('parse should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryToolError);
      if (err instanceof QueryToolError) {
        expect(err.problems.hasErrors).toBe(true);
        expect(err.report).not.toBe('');
        expect(err.message).toBe(err.report);
      }
    }
  });

  it('maps a schema envelope failure into schema.invalid problems', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    // A structured query missing required members fails the Zod envelope.
    try {
      await tool.parse(ctx, JSON.stringify({ query: { kind: 'select' } }));
      expect.unreachable('parse should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryToolError);
      if (err instanceof QueryToolError) {
        expect(err.problems.list.some((p) => p.code === 'schema.invalid')).toBe(true);
        expect(err.report).not.toBe('');
      }
    }
    // An array-index error path exercises the numeric path-segment branch.
    try {
      await tool.parse(
        ctx,
        JSON.stringify({ query: { kind: 'select', from: { kind: 'type', type: 'user' }, fields: [123] } }),
      );
      expect.unreachable('parse should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryToolError);
      if (err instanceof QueryToolError) {
        expect(err.problems.list.some((p) => p.code === 'schema.invalid')).toBe(true);
      }
    }
    // A malformed envelope with NO `query` key still renders a report (exercises
    // the raw-fallback rendering path).
    try {
      await tool.parse(ctx, JSON.stringify({ notQuery: 1 }));
      expect.unreachable('parse should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryToolError);
      if (err instanceof QueryToolError) {
        expect(err.problems.list.some((p) => p.code === 'schema.invalid')).toBe(true);
        expect(err.report).not.toBe('');
      }
    }
  });

  it('string-fallback mode reports needs-structuring', async () => {
    const fx = runtimeFixture();
    // max 0 → too many Types → string schema.
    const tool = buildQueryTool(fx.engine, { max: 0 });
    expect(tool.input.instructions ?? '').toContain('prose');
    try {
      await tool.parse(ctx, JSON.stringify({ query: 'find all users older than 30' }));
      expect.unreachable('parse should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryToolError);
      if (err instanceof QueryToolError) {
        expect(err.problems.list.some((p) => p.code === 'query.needs-structuring')).toBe(true);
      }
    }
  });

  it('prose input in structured mode is rejected', async () => {
    const fx = runtimeFixture();
    // Structured mode, but a string `query` fails the structured envelope.
    const tool = buildQueryTool(fx.engine);
    try {
      await tool.parse(ctx, JSON.stringify({ query: 'just prose' }));
      expect.unreachable('parse should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryToolError);
      if (err instanceof QueryToolError) {
        expect(err.problems.list.length).toBeGreaterThan(0);
      }
    }
  });
});
