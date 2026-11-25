/**
 * Runtime proofs for cletus's DBA query grammar (cletus-dba.ts): the 13
 * QUERY_EXAMPLES from packages/cletus/src/helpers/dba-examples.ts round-trip
 * on every profile, per-type schemas come from the types, recursion is JSON
 * text where the dialect has none, the string fallback takes over past
 * maxQuerySchemaTypes, and errors land at the model's path.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_STRICT, schemaHelpers,
} from '../../index';
import { asTool, MODEL_PROFILES, profileProblems, validate } from './_check';
import type { CletusCtx, TypeDefinition } from './cletus-tools';
import { QUERY_STRING_DOC, QuerySchema, QueryOutput, QueryToolArgs, queryTool, type BooleanValue, type Comparison, type Query, type Value } from './cletus-dba';
import { lines } from '../_lines';
export { TYPES } from './cletus-dba-fixtures';
import { TYPES } from './cletus-dba-fixtures';
const ctxOf = (types: TypeDefinition[], maxQuerySchemaTypes?: number): CletusCtx => {
  const data = { types, user: maxQuerySchemaTypes === undefined ? {} : { maxQuerySchemaTypes } };
  return { config: { getData: () => data } };
};

const col = (source: string, column: string): Value => ({ source, column });
const cmp = (left: Value, c: Comparison, right: Value): BooleanValue => ({ kind: 'comparison', left, cmp: c, right });

/** helpers/dba-examples.ts QUERY_EXAMPLES 1–12 (code shape). */
export const EXAMPLES: Query[] = [
  { kind: 'select', values: [{ alias: 'name', value: col('users', 'name') }], from: { kind: 'table', table: 'users' }, where: [cmp(col('users', 'active'), '=', true)], limit: 10 },
  {
    kind: 'select',
    values: [{ alias: 'userName', value: col('users', 'name') }, { alias: 'orderTotal', value: col('orders', 'total') }],
    from: { kind: 'table', table: 'users' },
    joins: [{ source: { kind: 'table', table: 'orders' }, type: 'inner', on: [cmp(col('users', 'id'), '=', col('orders', 'userId'))] }],
  },
  {
    kind: 'select',
    values: [{ alias: 'category', value: col('products', 'category') }, { alias: 'avgPrice', value: { kind: 'aggregate', aggregate: 'avg', value: col('products', 'price') } }],
    from: { kind: 'table', table: 'products' },
    groupBy: [col('products', 'category')],
  },
  { kind: 'insert', table: 'users', columns: ['name', 'email', 'age'], values: ['Alice Smith', 'alice@example.com', 30] },
  { kind: 'insert', table: 'users', columns: ['email', 'name'], values: ['bob@example.com', 'Bob Jones'], onConflict: { columns: ['email'], update: [{ column: 'name', value: 'Bob Jones' }] } },
  {
    kind: 'insert', table: 'archive_users', columns: ['name', 'email'],
    select: { kind: 'select', values: [{ alias: 'name', value: col('users', 'name') }, { alias: 'email', value: col('users', 'email') }], from: { kind: 'table', table: 'users' }, where: [cmp(col('users', 'active'), '=', false)] },
  },
  {
    kind: 'update', table: 'users',
    set: [{ column: 'active', value: false }, { column: 'deactivatedAt', value: { kind: 'function', function: 'now', args: [] } }],
    where: [cmp(col('users', 'lastLogin'), '<', '2023-01-01')],
  },
  { kind: 'delete', table: 'temp_data', where: [cmp(col('temp_data', 'created'), '<', '2024-01-01')] },
  { kind: 'select', values: [{ alias: 'all', value: col('users', '*') }], from: { kind: 'table', table: 'users' }, limit: 10 },
  {
    kind: 'select',
    values: [{ alias: 'all', value: col('users', '*') }, { alias: 'fullName', value: { kind: 'binary', left: col('users', 'firstName'), op: '+', right: col('users', 'lastName') } }],
    from: { kind: 'table', table: 'users' },
  },
  {
    kind: 'select',
    values: [{ alias: 'user1Name', value: col('u1', 'name') }, { alias: 'user2Name', value: col('u2', 'name') }, { alias: 'sharedDomain', value: col('u1', 'emailDomain') }],
    from: { kind: 'aliased', table: 'users', as: 'u1' },
    joins: [{
      source: { kind: 'aliased', table: 'users', as: 'u2' }, type: 'inner',
      on: [cmp(col('u1', 'emailDomain'), '=', col('u2', 'emailDomain')), cmp(col('u1', 'id'), '<', col('u2', 'id'))],
    }],
  },
  {
    kind: 'select',
    values: [{ alias: 'transaction', value: col('transactions', '*') }, { alias: 'similarity', value: { kind: 'semanticSimilarity', table: 'transactions', query: 'vehicle purchase car automotive' } }],
    from: { kind: 'table', table: 'transactions' },
    where: [cmp(col('transactions', 'amount'), '>', 1000)],
    orderBy: [{ value: { kind: 'semanticSimilarity', table: 'transactions', query: 'vehicle purchase car automotive' }, dir: 'desc' }],
    limit: 10,
  },
];

/** Example 13: a recursive CTE. It names CTEs ("project_hierarchy", "updated_projects") as tables. */
export const EXAMPLE_13: Query = {
  kind: 'withs',
  withs: [
    {
      kind: 'cte-recursive', name: 'project_hierarchy',
      statement: {
        kind: 'select',
        values: [
          { alias: 'id', value: col('projects', 'id') }, { alias: 'name', value: col('projects', 'name') },
          { alias: 'parentId', value: col('projects', 'parentId') }, { alias: 'status', value: col('projects', 'status') }, { alias: 'level', value: 0 },
        ],
        from: { kind: 'table', table: 'projects' },
        where: [cmp(col('projects', 'id'), '=', 'target-project-id')],
      },
      recursiveStatement: {
        kind: 'select',
        values: [
          { alias: 'id', value: col('p', 'id') }, { alias: 'name', value: col('p', 'name') }, { alias: 'parentId', value: col('p', 'parentId') },
          { alias: 'status', value: col('p', 'status') }, { alias: 'level', value: { kind: 'binary', left: col('ph', 'level'), op: '+', right: 1 } },
        ],
        from: { kind: 'aliased', table: 'projects', as: 'p' },
        joins: [{ source: { kind: 'aliased', table: 'project_hierarchy', as: 'ph' }, type: 'inner', on: [cmp(col('p', 'id'), '=', col('ph', 'parentId'))] }],
      },
    },
    {
      kind: 'cte', name: 'updated_projects',
      statement: {
        kind: 'update', table: 'projects', set: [{ column: 'assignedTo', value: 'user-123' }],
        from: { kind: 'table', table: 'project_hierarchy' },
        where: [cmp(col('projects', 'id'), '=', col('project_hierarchy', 'id')), cmp(col('project_hierarchy', 'status'), '=', 'active')],
        returning: [{ alias: 'id', value: col('projects', 'id') }],
      },
    },
  ],
  final: { kind: 'select', values: [{ alias: 'updatedCount', value: { kind: 'aggregate', aggregate: 'count', value: '*' } }], from: { kind: 'table', table: 'updated_projects' } },
};

/**
 * Every profile but two: OpenAI strict (17 levels of nesting > its 10: the request
 * depth-limits it, tested below; an absent optional NULLABLE clause also comes back
 * as null there, as documented) and MINIMAL (a gap, below).
 */
const PROFILES = [...MODEL_PROFILES, PEOPLE].filter((p) => p !== OPENAI_STRICT && p !== MINIMAL);

describe('the grammar on every profile, with the QUERY_EXAMPLES', () => {
  it('typed (7 tables): examples 1–12 round-trip everywhere', () => {
    expect(profileProblems(QuerySchema.bind(TYPES), EXAMPLES, { tool: false, profiles: PROFILES })).toEqual([]);
  });
  it('untyped (no types: generic Insert/Update/Delete, string tables): examples 1–13 round-trip everywhere', () => {
    expect(profileProblems(QuerySchema.bind([]), [...EXAMPLES, EXAMPLE_13], { tool: false, profiles: PROFILES })).toEqual([]);
  });
  it('as the query tool\'s args (both forms) and the query_builder output', () => {
    expect(profileProblems(QueryToolArgs.bind(ctxOf(TYPES, 10)), EXAMPLES.slice(0, 4).map((query) => ({ query })), { profiles: PROFILES })).toEqual([]);
    expect(profileProblems(QueryToolArgs.bind(ctxOf(TYPES)), [{ query: 'Select the names of active users, limited to 10 results.' }])).toEqual([]);
    expect(profileProblems(QueryOutput.bind({}, { types: TYPES.slice(0, 2) }), EXAMPLES.slice(0, 2).map((query) => ({ query })), { tool: false, profiles: PROFILES })).toEqual([]);
  });
});

/** Absent and null optional-nullable clauses mean the same to cletus (`if (q.where)`); compare without nulls. */
const noNulls = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));

describe('OpenAI strict, through the request (17 levels of nesting > 10: depth-limited)', () => {
  const data = { types: TYPES, user: { maxQuerySchemaTypes: 10 } };
  const entry = () => ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'query', schema: QueryToolArgs.bind({ config: { getData: () => data } }) }]).get('query');

  it('stays strict with deep parts as JSON text; every example round-trips (absent clauses come back as null)', () => {
    const e = entry();
    expect(e.strict).toBe(true);
    expect(e.reasons).toEqual(['"query": 17 levels of nesting (limit 10)']);
    expect(e.adjustments.map((x) => x.kind)).toContain('depth-limited');
    expect(e.measure.depth).toBeLessThanOrEqual(10);
    for (const query of [...EXAMPLES]) {
      const wire = e.encode({ query });
      expect(validate(e.jsonSchema!, wire)).toEqual([]);
      const res = e.parseText(JSON.stringify(wire));
      expect(res.ok).toBe(true);
      if (res.ok) expect(noNulls(res.value)).toEqual({ query });
    }
  });

  it('an optional NULLABLE clause written as null stays null (the documented gotcha); nothing is copied', () => {
    const r = QueryOutput.bind({}, { types: TYPES }).render(OPENAI_STRICT);
    const wire = { query: { kind: 'select', distinct: null, values: [{ alias: 'name', value: { source: 'users', column: 'name' } }], from: { kind: 'table', table: 'users' }, joins: null, where: [{ kind: 'comparison', left: { source: 'users', column: 'active' }, cmp: '=', right: true }], groupBy: null, having: null, orderBy: null, offset: null, limit: 10 } };
    const res = r.parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.ok && res.value.query).toMatchObject({ distinct: null, joins: null, limit: 10 });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
  });
});

describe('emitted JSON', () => {
  it('OpenAI strict: every aid name is a $def; Table/SourceColumn/Insert come from the types', () => {
    const js = QuerySchema.bind(TYPES).render(OPENAI_STRICT).jsonSchema as any;
    expect(Object.keys(js.$defs).sort()).toEqual([
      'Aggregate', 'Alias', 'AliasValue', 'Binary', 'BooleanValue', 'CTEStatement', 'Column', 'ColumnValue', 'Comparison', 'Constant',
      'DataSource', 'Delete', 'Function', 'FunctionCall', 'Insert', 'Join', 'Query', 'Select', 'SelectOrSet', 'SetOperation', 'Sort',
      'Source', 'SourceColumn', 'Statement', 'Table', 'Unary', 'Update', 'Value', 'WindowValue', 'WithStatement',
    ].filter((n) => n in js.$defs).sort());
    expect(js.$defs.Table.enum).toEqual(TYPES.map((t) => t.name));
    expect(js.$defs.Table.description).toBe('Database table. Tables: Users (users); Orders (orders); Products (products); Archive_users (archive_users); Temp_data (temp_data); Transactions (transactions); Projects (projects)');
    // One typed insert per type with fields (temp_data has none), a literal table and a column enum.
    expect(js.$defs.Insert.anyOf.map((o: any) => o.properties.table.enum[0])).toEqual(['users', 'orders', 'products', 'archive_users', 'transactions', 'projects']);
    expect(js.$defs.Insert.anyOf[1].properties.columns.items.enum).toEqual(['id', 'created', 'updated', 'userId', 'total']);
    // Delete: every type (fields or not).
    expect(js.$defs.Delete.anyOf).toHaveLength(7);
    // SourceColumn: one per type, plus the generic alias/CTE form.
    expect(js.$defs.SourceColumn.anyOf).toHaveLength(8);
    expect(js.$defs.SourceColumn.anyOf[7].description).toBe('Reference to a column from a CTE, aliased table/subquery');
  });

  it('one type: Insert/Update are that type\'s form, not a union; no types: the generic forms with a string Table', () => {
    const one = QuerySchema.bind(TYPES.slice(1, 2)).render(OPENAI_STRICT).jsonSchema as any;
    expect(one.$defs.Insert.anyOf).toBeUndefined();
    expect(one.$defs.Insert.properties.table.enum).toEqual(['orders']);
    const none = QuerySchema.bind([]).render(OPENAI_STRICT).jsonSchema as any;
    expect(none.$defs.Table).toEqual({ type: 'string', description: 'Database table name' });
    expect(none.$defs.Insert.properties.table.$ref).toBe('#/$defs/Table');
  });

  it('Anthropic strict (no recursion): Value is JSON text, and the named types are listed as TypeScript', () => {
    const js = QueryOutput.bind({}, { types: TYPES.slice(0, 2) }).render(ANTHROPIC_STRICT).jsonSchema as any;
    expect(js.description).toContain('Named types used by the fields written as JSON text:');
    expect(js.description).toContain('type Table = "users" | "orders"');
    expect(js.description).toContain('type SourceColumn = { source: "users"; column: "id" | "created" | "updated" | "name"');
    expect(js.properties.query).toEqual({ $ref: '#/$defs/Query' });
  });

  it('Gemini OpenAPI (no $defs): the grammar is inlined with JSON-text escapes', () => {
    const js = QueryOutput.bind({}, { types: TYPES.slice(0, 2) }).render(GOOGLE_OPENAPI).jsonSchema;
    expect(js.$defs).toBeUndefined();
    expect(JSON.stringify(js)).not.toContain('$ref');
  });
});

describe('the shouldUseStringSchema fallback (tools/dba.ts:146)', () => {
  it('more types than maxQuerySchemaTypes (default 5): the query is a string description', () => {
    const js = QueryToolArgs.bind(ctxOf(TYPES)).render(asTool(OPENAI_STRICT)).jsonSchema as any;
    // Only the string is sent: none of the grammar's named types is reachable, so none is emitted.
    expect(js.properties.query).toEqual({ $ref: '#/$defs/QueryArg' });
    expect(js.$defs).toEqual({ QueryArg: { type: 'string', description: QUERY_STRING_DOC } });
    const res = QueryToolArgs.bind(ctxOf(TYPES)).render(asTool(OPENAI_STRICT)).parse({ query: 'top 5 users by completed tasks' });
    expect(res.ok && res.value).toEqual({ query: 'top 5 users by completed tasks' });
  });

  it('within the limit: the structured grammar; the bind is cached per config data', () => {
    const c = ctxOf(TYPES, 10);
    const js = QueryToolArgs.bind(c).render(asTool(ANTHROPIC_STRICT)).jsonSchema as any;
    expect(js.properties.query.$ref).toBe('#/$defs/QueryArg');
    expect(QueryToolArgs.bind(c)).toBe(QueryToolArgs.bind(c));
    expect(queryTool.applicable!(ctxOf([]))).toBe(false);
    expect(queryTool.call({ query: 'x' }, c)).toBe('describe: x');
    expect(queryTool.call({ query: EXAMPLES[3]! }, c)).toBe('insert');
  });
});

describe('decoding model answers', () => {
  it('Anthropic strict: each Value is JSON text, parsed once and decoded in place', () => {
    const r = QueryOutput.bind({}, { types: TYPES }).render(ANTHROPIC_STRICT);
    const answer = () => ({ query: { kind: 'select', values: [{ alias: 'name', value: '{"source":"users","column":"name"}' }], from: { kind: 'table', table: 'users' }, where: [{ kind: 'comparison', left: '{"source":"users","column":"active"}', cmp: '=', right: 'true' }], limit: 10 } });
    const wire = answer();
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ query: EXAMPLES[0] });
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 3, parsed: 3, repaired: 0 });
    // The encoder writes the same shape (what {{encode}} shows in the QUERY_EXAMPLES).
    expect(r.encode({ query: EXAMPLES[0]! })).toEqual(answer());
  });

  it('Anthropic strict: a Value sent as an object instead of JSON text is taken as is (repair)', () => {
    const r = QueryOutput.bind({}, { types: TYPES }).render(ANTHROPIC_STRICT);
    const res = r.parse({ query: { kind: 'select', values: [{ alias: 'name', value: { source: 'users', column: 'name' } }] } });
    expect(res.ok && res.value).toEqual({ query: { kind: 'select', values: [{ alias: 'name', value: { source: 'users', column: 'name' } }] } });
    expect(res.stats.repaired).toBe(1);
  });

  it('xAI strict (no recursion, open records): JSON text too', () => {
    const r = QueryOutput.bind({}, { types: TYPES }).render(XAI_STRICT);
    expect(r.parse(JSON.parse(JSON.stringify(r.encode({ query: EXAMPLES[2]! })))).ok).toBe(true);
  });
});

describe('validation errors', () => {
  it('QUERY_EXAMPLES 13 names CTEs as tables: with types defined, the Table enum rejects them at the model path', () => {
    const res = QueryOutput.bind({}, { types: TYPES }).render(OPENAI_STRICT).parse({ query: EXAMPLE_13 });
    expect(!res.ok && res.issues.map((i) => i.path)).toEqual([
      ['query', 'withs', 0, 'recursiveStatement', 'joins', 0, 'source', 'table'],
      ['query', 'withs', 1, 'statement', 'from', 'table'],
      ['query', 'final', 'from', 'table'],
    ]);
    expect(lines(res).split('\n')[2]).toBe('- at query.final.from.table: Expected one of: users, orders, products, archive_users, temp_data, transactions, projects.');
  });

  it('a column not in the typed table\'s enum (insert), and a JSON-text Value that is not JSON', () => {
    const r = QueryOutput.bind({}, { types: TYPES }).render(LENIENT);
    const res = r.parse({ query: { kind: 'insert', table: 'users', columns: ['nope'] } });
    expect(!res.ok && res.issues).toEqual([{ path: ['query', 'columns', 0], codePath: ['query', 'columns', 0], message: 'Expected one of: id, created, updated, name, email, age, active, lastLogin, firstName, lastName, emailDomain, deactivatedAt.' }]);
    // Faithful to cletus: a SourceColumn with an unknown column still matches the generic (alias/CTE) branch.
    expect(r.parse({ query: { kind: 'select', values: [{ alias: 'x', value: { source: 'users', column: 'nope' } }] } }).ok).toBe(true);
    const an = QueryOutput.bind({}, { types: TYPES }).render(ANTHROPIC_STRICT).parse({ query: { kind: 'select', values: [{ alias: 'x', value: '{source:' }] } });
    expect(!an.ok && an.issues[0]!.path).toEqual(['query', 'values', 0, 'value']);
  });
});

describe('the examples in prompts: {{encode}} shows them in the model\'s shape', () => {
  it('query_builder on Anthropic strict: the grammar alone is over the request limits, so the whole query is JSON text (still strict)', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'output', schema: QueryOutput.bind({}, { types: TYPES }) }]);
    const e = req.get('output');
    expect([e.strict, e.delivery]).toEqual([true, 'structured']);
    expect(e.reasons).toEqual(['"output" alone: 113 optional properties (limit 24)', '"output" alone: 130 union-typed properties (limit 16)']);
    expect(e.adjustments.at(-1)).toEqual({ kind: 'depth-limited', maxDepth: 1 });
    expect(e.measure).toMatchObject({ depth: 1, optional: 0 });
    // {{queryExamples}} then shows each example the way this model writes it: as JSON text.
    const t = Handlebars.compile('Example 4: {{encode ex path="query"}}', { noEscape: true });
    expect(t({ ex: EXAMPLES[3] }, { helpers: req.helpers() })).toBe(`Example 4: ${JSON.stringify(JSON.stringify(EXAMPLES[3]))}`);
    const res = e.parse({ query: JSON.stringify(EXAMPLES[3]) });
    expect(res.ok && res.value).toEqual({ query: EXAMPLES[3] });
    expect(res.stats.parsed).toBe(1);
  });

  it('query_fixer on OpenAI strict: {{encode}} writes absent clauses as null', () => {
    const o = QueryOutput.bind({}, { types: TYPES }).render(OPENAI_STRICT);
    expect(Handlebars.compile('{{encode ex path="query"}}', { noEscape: true })({ ex: EXAMPLES[7] }, { helpers: schemaHelpers(o) })).toBe(
      '{"kind":"delete","table":"temp_data","as":null,"joins":null,"where":[{"kind":"comparison","left":{"source":"temp_data","column":"created"},"cmp":"<","right":"2024-01-01"}],"returning":null}',
    );
  });
});

describe('gaps', () => {
  // Every `.nullable().optional()` clause (dba.ts:397-406...). MINIMAL writes absent as null and nulls as a
  // type array; the two together come out as anyOf[[T, null], null] — a combinator in a dialect with none.
  it('(was GAP) optional-nullable-minimal — an optional nullable field on MINIMAL emits anyOf', () => {
    expect(profileProblems(QuerySchema.bind([]), EXAMPLES.slice(0, 1), { tool: false, profiles: [MINIMAL] })).toEqual([]);
  });

  // Fitting the query tool for OpenAI: only the depth is over (17 > 10), so only the depth is cut; the
  // enums over 8 values (Function, column enums) keep their constraints. (Was GAP ladder-widens-enums.)
  it('a depth-only overflow cuts the depth and keeps the enums (was GAP ladder-widens-enums)', () => {
    const data = { types: TYPES, user: { maxQuerySchemaTypes: 10 } };
    const e = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'query', schema: QueryToolArgs.bind({ config: { getData: () => data } }) }]).get('query');
    expect(e.adjustments.map((x) => x.kind)).toEqual(['depth-limited']);
  });
});
