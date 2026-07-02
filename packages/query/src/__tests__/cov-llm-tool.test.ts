/**
 * Coverage: buildQueryTool — descriptor + build() across valid/run, schema
 * errors, validation errors, string-fallback, prose input, and parse errors.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, ref } from './_utils';
import { buildQueryTool } from '../llm/tool';
import type { SelectDef } from '../schema';

const validSelect: SelectDef = {
  kind: 'select',
  fields: [{ expr: ref('user', 'id'), as: 'id' }],
  from: { kind: 'type', type: 'user' },
  order: [{ expr: ref('user', 'id'), dir: 'asc' }],
};

describe('buildQueryTool', () => {
  it('descriptor carries name/description/instructions/schema', () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine, { name: 'q', description: 'D' });
    expect(tool.name).toBe('q');
    expect(tool.description).toBe('D');
    expect(tool.instructions).toContain('Types');
    expect(tool.schema).toBeTruthy();
    // Default name/description
    const dflt = buildQueryTool(fx.engine);
    expect(dflt.name).toBe('query');
    expect(dflt.description).toContain('structured query');
  });

  it('runs a valid structured query when built with run: true', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine, { run: true });
    const out = await tool.build({ query: validSelect });
    expect(out.query).not.toBeNull();
    expect(out.problems.hasErrors).toBe(false);
    expect(out.result).toBeDefined();
    expect(out.result!.rows.length).toBe(3);
  });

  it('reports validation errors and does not run', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine, { run: true });
    const bad: SelectDef = { kind: 'select', fields: [{ expr: ref('user', 'ghost') }], from: { kind: 'type', type: 'user' } };
    const out = await tool.build({ query: bad });
    expect(out.problems.hasErrors).toBe(true);
    expect(out.report).not.toBe('');
    expect(out.result).toBeUndefined();
  });

  it('maps a schema failure into schema.invalid problems', async () => {
    const fx = runtimeFixture();
    const tool = buildQueryTool(fx.engine);
    // A structured query missing required members fails the Zod envelope.
    const out = await tool.build({ query: { kind: 'select' } as never });
    expect(out.query).toBeNull();
    expect(out.problems.list.some((p) => p.code === 'schema.invalid')).toBe(true);
    expect(out.report).not.toBe('');
    // An array-index error path exercises the numeric path-segment branch.
    const idx = await tool.build({ query: { kind: 'select', from: { kind: 'type', type: 'user' }, fields: [123] } as never });
    expect(idx.problems.list.some((p) => p.code === 'schema.invalid')).toBe(true);
  });

  it('string-fallback mode reports needs-structuring', async () => {
    const fx = runtimeFixture();
    // max 0 → too many Types → string schema.
    const tool = buildQueryTool(fx.engine, { max: 0 });
    expect(tool.instructions).toContain('prose');
    const out = await tool.build({ query: 'find all users older than 30' });
    expect(out.query).toBeNull();
    expect(out.problems.list.some((p) => p.code === 'query.needs-structuring')).toBe(true);
  });

  it('prose input in structured mode is rejected as needing structuring', async () => {
    const fx = runtimeFixture();
    // A very high `max` keeps structured mode, but a string `query` still fails
    // the structured envelope → schema.invalid (a non-object query value).
    const tool = buildQueryTool(fx.engine);
    const out = await tool.build({ query: 'just prose' });
    expect(out.query).toBeNull();
    expect(out.problems.list.length).toBeGreaterThan(0);
  });
});
