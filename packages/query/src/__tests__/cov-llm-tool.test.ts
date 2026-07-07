/**
 * Coverage: buildQueryTool — the core `Tool` surface across descriptor
 * metadata, valid/run, schema errors, validation errors, string-fallback, and
 * prose input. `tool.parse` returns the built `Query` (or THROWS a
 * `QueryToolError`); `tool.run` executes the validated query.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool, QueryToolError, type BuildQueryToolOptions } from '../llm/tool';
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

  it('honors the `report` FormatProblemsOptions override (context / gutter)', async () => {
    // A query with a deep, off-first-line error so surrounding context is
    // meaningful: a bad field-ref in the SECOND selected field.
    const bad: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id') }, { expr: ref('user', 'ghost') }],
      from: { kind: 'type', type: 'user' },
    };

    /** Parse `bad` under a `report` option and return the rendered report. */
    const reportUnder = async (report?: BuildQueryToolOptions['report']): Promise<string> => {
      const fx = runtimeFixture();
      const tool = buildQueryTool(fx.engine, report ? { report } : {});
      try {
        await tool.parse(ctx, JSON.stringify({ query: bad }));
        expect.unreachable('parse should have thrown');
      } catch (err) {
        if (err instanceof QueryToolError) return err.report;
        throw err;
      }
      /* v8 ignore next -- unreachable: the catch above always returns or rethrows */
      return '';
    };

    const dflt = await reportUnder();
    const noContext = await reportUnder({ contextLines: 0 });
    const moreContext = await reportUnder({ contextLines: 4 });
    const noGutter = await reportUnder({ lineNumbers: false });

    // The underlined offending value + directed message are present regardless.
    for (const r of [dflt, noContext, moreContext]) {
      expect(r).toContain("has no field 'ghost'");
      expect(r).toContain('^^^');
    }

    // `contextLines: 0` shows NO surrounding context — strictly fewer lines than
    // the default (contextLines: 2); `contextLines: 4` shows strictly more.
    expect(noContext.split('\n').length).toBeLessThan(dflt.split('\n').length);
    expect(moreContext.split('\n').length).toBeGreaterThan(dflt.split('\n').length);

    // `contextLines: 0` narrows the rendered window to just the underlined span
    // (lines 12-16); the default (contextLines: 2) extends it to lines 10-18,
    // so the default renders line 10 in its gutter but `contextLines: 0` does not.
    expect(dflt).toContain('10 │');
    expect(noContext).not.toContain('10 │');

    // `lineNumbers: false` drops the `N │` gutter the default renders.
    expect(dflt).toMatch(/\d+ │ /);
    expect(noGutter).not.toContain('│');
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
