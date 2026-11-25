/**
 * The `a` schemas cletus gives models decode a model-shaped answer back into
 * the code shape (OpenAI strict: absent optionals written as null, records
 * as pairs).
 */
import { describe, expect, it } from '@jest/globals';
import { a, LENIENT } from '@aeye/schema';
import { planRequest, Tool } from '@aeye/core';
import { DBAGrammar, dbaTypeDefs, typesKey, type Query } from '../dba';
import { buildFieldsSchema, TypeNameModule, type TypesContext } from '../type';
import { ChartConfigSchema } from '../artist';
import type { TypeDefinition } from '../../schemas';

const STRICT = { id: 'gpt-4o', provider: 'openai', capabilities: ['toolsStrict'] };

const types: TypeDefinition[] = [
  {
    name: 'task',
    friendlyName: 'Task',
    knowledgeTemplate: '{{name}}',
    fields: [
      { name: 'name', friendlyName: 'Name', type: 'string', required: true },
      { name: 'done', friendlyName: 'Done', type: 'boolean', default: false },
      { name: 'due', friendlyName: 'Due', type: 'date' },
    ],
  },
  {
    name: 'user',
    friendlyName: 'User',
    knowledgeTemplate: '{{name}}',
    fields: [{ name: 'name', friendlyName: 'Name', type: 'string', required: true }],
  },
];

const ctx = { config: { getData: () => ({ types, user: {} }) } } as unknown as TypesContext;

/** A tool's definition and plan for OpenAI strict, and its args parsed through it. */
async function parseStrict<T extends object>(tool: Tool<any, any, string, T, any, any, any>, args: unknown) {
  const definition = (await tool.definition(ctx as any))!;
  const plan = planRequest({ tools: [definition] }, STRICT);
  const entry = plan.get(tool.name as never) as unknown as { strict: boolean; jsonSchema: unknown };
  return { entry, value: await tool.parse(ctx as any, JSON.stringify(args), plan) };
}

describe('cletus tool schemas', () => {
  it('data_get: the type enum comes from the config; null optionals become absent', async () => {
    const tool = new Tool({
      name: 'data_get',
      description: 'Get paginated records of a data type',
      schema: TypeNameModule.result(a.object({
        type: a.ref('TypeName'),
        offset: a.number().optional(),
        limit: a.number().optional(),
      })),
      call: (input: { type: string; offset?: number; limit?: number }) => input,
    });
    const { entry, value } = await parseStrict(tool, { type: 'task', offset: null, limit: 5 });
    expect(entry.strict).toBe(true);
    expect(JSON.stringify(entry.jsonSchema)).toContain('"user"');
    expect(value).toEqual({ type: 'task', limit: 5 });
    expect('offset' in value).toBe(false);

    await expect(parseStrict(tool, { type: 'project', offset: null, limit: null })).rejects.toThrow(/type/);
  });

  it('query: the grammar for the configured types decodes a select', async () => {
    const tool = new Tool({
      name: 'query',
      description: 'Execute queries',
      schema: DBAGrammar
        .dynamic((c: TypesContext) => dbaTypeDefs(c.config.getData().types), { key: (c) => typesKey(c.config.getData().types) })
        .result(a.object({ query: a.ref('Query') })),
      call: (input: { query: Query }) => input,
    });
    const select = {
      kind: 'select',
      distinct: null,
      values: [{ alias: 'n', value: { source: 'task', column: 'name' } }],
      from: { kind: 'table', table: 'task' },
      joins: null,
      where: [{ kind: 'comparison', left: { source: 'task', column: 'done' }, cmp: '=', right: false }],
      groupBy: null,
      having: null,
      orderBy: null,
      offset: null,
      limit: 10,
    };
    const { value } = await parseStrict(tool, { query: select });
    expect(value.query.kind).toBe('select');
    expect((value.query as any).limit).toBe(10);
    expect((value.query as any).where[0].right).toBe(false);

    // A table that isn't a configured type is refused.
    const bad = { ...select, from: { kind: 'table', table: 'project' } };
    await expect(parseStrict(tool, { query: bad })).rejects.toThrow();
  });

  it('extractor fields: defaults are filled and optional fields are nullable', () => {
    const output = a.object({ results: a.array(buildFieldsSchema(types[0])) });
    const res = output.render(LENIENT).parse({ results: [{ name: 'a', due: null }, { name: 'b', done: true, due: '2026-01-02' }] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.results).toEqual([{ name: 'a', done: false, due: null }, { name: 'b', done: true, due: '2026-01-02' }]);
    }
    expect(output.render(LENIENT).parse({ results: [{ due: null }] }).ok).toBe(false);
  });

  it('chart_display: variant options sent as pairs decode to records', async () => {
    const tool = new Tool({
      name: 'chart_display',
      description: 'Display a chart',
      schema: a.object({ chart: ChartConfigSchema }),
      call: (input) => input,
    });
    const { value } = await parseStrict(tool, {
      chart: {
        chartGroup: 'categoryComparison',
        title: null,
        data: [{ name: 'A', value: 1 }],
        variantOptions: [{ key: 'bar', value: '{"barWidth":10}' }],
        defaultVariant: 'bar',
      },
    });
    expect(value.chart).toEqual({
      chartGroup: 'categoryComparison',
      data: [{ name: 'A', value: 1 }],
      variantOptions: { bar: { barWidth: 10 } },
      defaultVariant: 'bar',
    });
  });
});
