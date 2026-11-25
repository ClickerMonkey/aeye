/**
 * Coverage: buildQueryTool — the core `Tool` surface across descriptor
 * metadata, valid/run, schema errors, validation errors, string-fallback, and
 * prose input. `tool.parse` returns the built `Query` (or THROWS a
 * `SchemaParseError` whose message is what the model is told, in
 * @aeye/schema's format); `tool.run` executes the validated query.
 * `parseQueryTool` (no tool) keeps the `QueryToolError` + `Code` report.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@aeye/core';
import { SchemaParseError } from '@aeye/schema';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool, parseQueryTool, QueryToolError, type BuildQueryToolOptions } from '../llm/tool';
import type { SelectDef } from '../schema';

const validSelect: SelectDef = {
  kind: 'select',
  fields: [{ expr: ref('user', 'id'), as: 'id' }],
  from: { kind: 'type', type: 'user' },
  order: [{ expr: ref('user', 'id'), dir: 'asc' }],
};

/** A minimal, cast-free context for `tool.parse` / `tool.run`. */
const ctx: Context<{}, {}> = {};

/** The error `tool.parse` rejects with. */
async function rejection(p: Promise<unknown>): Promise<SchemaParseError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaParseError);
    return err as SchemaParseError;
  }
  return expect.unreachable('parse should have thrown');
}

describe('buildQueryTool', () => {
  it('descriptor carries name/description/instructions/schema', () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine, { name: 'q', description: 'D' });
    expect(tool.name).toBe('q');
    expect(tool.description).toBe('D');
    expect(tool.input.instructions ?? '').toContain('Types');
    expect(tool.input.schema).toBeTruthy();
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

  it('a SEMANTIC problem is told to the model at its path (and the call does not run)', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    const bad: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'ghost') }],
      from: { kind: 'type', type: 'user' },
    };
    const err = await rejection(tool.parse(ctx, JSON.stringify({ query: bad })));
    expect(err.issues.some((i) => JSON.stringify(i.codePath).startsWith('["query","fields",0'))).toBe(true);
    expect(err.message).toContain("has no field 'ghost'");
    expect(err.message).toContain('^');
  });

  it('a STRUCTURAL problem is the schema\'s: missing members, a wrong type, the envelope', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    const missing = await rejection(tool.parse(ctx, JSON.stringify({ query: { kind: 'select' } })));
    const paths = missing.issues.map((i) => JSON.stringify(i.codePath));
    expect(paths).toContain(JSON.stringify(['query', 'fields']));
    expect(paths).toContain(JSON.stringify(['query', 'from']));

    const notObject = await rejection(
      tool.parse(ctx, JSON.stringify({ query: { kind: 'select', from: { kind: 'type', type: 'user' }, fields: [123] } })),
    );
    expect(notObject.issues.some((i) => JSON.stringify(i.codePath) === JSON.stringify(['query', 'fields', 0]))).toBe(true);

    const envelope = await rejection(tool.parse(ctx, JSON.stringify({ notQuery: 1 })));
    expect(envelope.issues.some((i) => JSON.stringify(i.codePath) === JSON.stringify(['query']))).toBe(true);

    const scalar = await rejection(tool.parse(ctx, JSON.stringify(42)));
    expect(scalar.issues.length).toBeGreaterThan(0);
  });

  it('string-fallback mode reports needs-structuring', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine, { max: 0 });
    expect(tool.input.instructions ?? '').toContain('prose');
    const err = await rejection(tool.parse(ctx, JSON.stringify({ query: 'find all users older than 30' })));
    expect(err.message).toContain('must be converted to a structured query');
  });

  it('the `errorFormat` option sets how much the model is told', async () => {
    const fx = runtimeFixture();
    const bad = JSON.stringify({ query: { ...validSelect, fields: [{ expr: ref('user', 'ghost') }] } });
    const full = await rejection(buildQueryTool(fx.engine).parse(ctx, bad));
    const summary = await rejection(buildQueryTool(fx.engine, { errorFormat: 'summary' }).parse(ctx, bad));
    expect(summary.message.length).toBeLessThan(full.message.length);
    expect(summary.message).not.toContain('^');
  });

  it('parseQueryTool honors the `report` FormatProblemsOptions override (context / gutter)', () => {
    // A deep, off-first-line error so surrounding context is meaningful: a bad
    // field-ref in the SECOND selected field.
    const bad: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id') }, { expr: ref('user', 'ghost') }],
      from: { kind: 'type', type: 'user' },
    };
    const reportUnder = (report?: BuildQueryToolOptions['report']): string => {
      const fx = runtimeFixture();
      const out = parseQueryTool(fx.engine, { query: bad }, report ? { report } : {});
      expect(out).toBeInstanceOf(QueryToolError);
      return out instanceof QueryToolError ? out.report : '';
    };

    const dflt = reportUnder();
    const noContext = reportUnder({ contextLines: 0 });
    const moreContext = reportUnder({ contextLines: 4 });
    const noGutter = reportUnder({ lineNumbers: false });

    for (const r of [dflt, noContext, moreContext, noGutter]) {
      expect(r).toContain("has no field 'ghost'");
      expect(r).toContain('^^^');
    }
    expect(noContext.split('\n').length).toBeLessThan(dflt.split('\n').length);
    expect(moreContext.split('\n').length).toBeGreaterThan(dflt.split('\n').length);
    expect(dflt).toMatch(/\d+ │ /);
    expect(noGutter).not.toContain('│');
  });

  it('parseQueryTool: envelope, prose and valid inputs', () => {
    const fx = runtimeFixture();
    const notObject = parseQueryTool(fx.engine, 42);
    expect(notObject instanceof QueryToolError && notObject.problems.list[0]?.code).toBe('shape.not-object');
    const noQuery = parseQueryTool(fx.engine, { notQuery: 1 });
    expect(noQuery instanceof QueryToolError && noQuery.problems.list[0]?.message).toBe('missing required field `query`');
    const prose = parseQueryTool(fx.engine, { query: 'just prose' });
    expect(prose instanceof QueryToolError && prose.problems.list.some((p) => p.code === 'query.needs-structuring')).toBe(true);
    expect(parseQueryTool(fx.engine, { query: validSelect })).not.toBeInstanceOf(QueryToolError);
  });

  it('prose input in structured mode is rejected by the schema', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    const err = await rejection(tool.parse(ctx, JSON.stringify({ query: 'just prose' })));
    expect(err.issues.length).toBeGreaterThan(0);
  });
});
