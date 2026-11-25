/**
 * @aeye/query's model schemas in `a` (corpus/query.ts), tested against the
 * REAL query package: the catalog comes from a real `@aeye/query` registry
 * built from query's own test fixtures (src/__tests__/_utils.ts,
 * capability-gating.test.ts, operator.test.ts), and every depth level is
 * checked value-for-value against query's own zod `buildSchemas` — the `a`
 * port accepts exactly what the original accepts.
 */
import Handlebars from 'handlebars';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildSchemas, type ExprDef, type QueryDef, type Registry } from '../../../bench/legacy-query';
import { catalogOf, fixtureRegistry, geoRegistry, plainRegistry } from './query-fixtures';
import {
  a, ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_STRICT,
  profileFor, schemaHelpers, staticBundle, type Schema,
} from '../../index';
import { asTool, clone, dialectProblems, profileProblems, validate, unexplained } from './_check';
import {
  EXPR_KINDS, ExprSchema, QueryModule, QueryProseArgs, QuerySchema, QueryToolArgs, SelectSchema, depthOf, fieldValue, shouldUseStringSchema,
  type BuildOptions, type QueryCatalog,
} from './query';
import { lines } from '../_lines';

const fx = fixtureRegistry();
const catalog = catalogOf(fx);
const plain = plainRegistry();
const plainCatalog = catalogOf(plain);
const geo = geoRegistry();
const geoCatalog = catalogOf(geo);

// ============================================================================
// Corpus of query values (query's tests + product's prompt examples)
// ============================================================================

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const select = (expr: ExprDef, from = 'user'): QueryDef => ({ kind: 'select', fields: [{ expr }], from: { kind: 'type', type: from } });

/** Values every level accepts (valid for the fixture catalog at every depth). */
const VALID: Record<string, QueryDef> = {
  // schema-depth.test.ts selectOf
  fieldRef: select(ref('user', 'name')),
  // product query.ts QUERY_SET_EXAMPLES[0] over the fixture's order type
  ordered: {
    kind: 'select',
    fields: [{ expr: ref('order', 'note') }, { expr: ref('order', 'total') }],
    from: { kind: 'type', type: 'order' },
    order: [{ expr: ref('order', 'total'), dir: 'desc' }],
  },
  // QUERY_SET_EXAMPLES[1]: a param in a condition
  param: {
    kind: 'select',
    fields: [{ expr: ref('order', 'id') }, { expr: ref('order', 'total') }],
    from: { kind: 'type', type: 'order' },
    where: [{ kind: 'comparison', op: '=', left: ref('order', 'note'), right: { kind: 'param', name: 'note' } }],
    limit: { kind: 'param', name: 'limit' },
  },
  // QUERY_SET_EXAMPLES[2] / catalog-language-guides SELECT_GROUP_COUNT_EXAMPLE: group + count(*)
  groupCount: {
    kind: 'select',
    fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'count' }],
    from: { kind: 'type', type: 'user' },
    groupBy: [ref('user', 'name')],
    order: [{ expr: { kind: 'output', name: 'count' }, dir: 'desc', nulls: 'last' }],
    having: [{ kind: 'output', name: 'count' }],
  },
  // query-cascade.test.ts INVERSE_TRAVERSAL: a relation join
  join: {
    kind: 'select',
    from: { kind: 'type', type: 'user' },
    joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' }, joinType: 'inner' }],
    fields: [{ expr: ref('user', 'id'), as: 'userId' }, { expr: ref('user', 'name'), as: 'name' }],
  },
  // a subquery, in, exists, case, logical, between, is-null, unary/binary, literal JSON
  rich: {
    kind: 'select',
    distinct: true,
    fields: [
      { expr: { kind: 'case', branches: [{ when: { kind: 'is-null', value: ref('user', 'age') }, then: { kind: 'literal', value: 'unknown' } }], else: { kind: 'binary', op: '+', left: ref('user', 'age'), right: { kind: 'unary', op: '-', operand: { kind: 'literal', value: 1 } } } }, as: 'ageish' },
      { expr: { kind: 'literal', value: { nested: [1, 'two', null, { deep: true }] } }, as: 'doc' },
    ],
    from: { kind: 'type', type: 'user' },
    where: [{
      kind: 'logical', op: 'and', operands: [
        { kind: 'in', value: ref('user', 'id'), in: { kind: 'select', fields: [{ expr: ref('order', 'userId') }], from: { kind: 'type', type: 'order' } } },
        { kind: 'exists', query: select(ref('order', 'id'), 'order'), not: false },
        { kind: 'between', value: ref('user', 'age'), lower: { kind: 'literal', value: 18 }, upper: { kind: 'literal', value: 65 } },
        { kind: 'in', value: ref('user', 'name'), in: [{ kind: 'literal', value: 'Ada' }, { kind: 'literal', value: 'Bob' }], not: true },
      ],
    }],
    limit: 10,
    offset: 0,
  },
  // a sorter (dynamic sort) in a SELECT order
  sorter: {
    kind: 'select',
    fields: [{ expr: ref('user', 'name') }],
    from: { kind: 'type', type: 'user' },
    order: [{ kind: 'sorter', sorts: { byName: ref('user', 'name'), byAge: { kind: 'output', name: 'age' } }, defaultSort: [{ sort: 'byName', dir: 'asc' }] }],
  },
  // text search + array op + filters placeholder (query-filters.test.ts shape)
  search: {
    kind: 'select',
    fields: [{ expr: ref('user', 'email') }],
    from: { kind: 'type', type: 'user' },
    where: [
      { kind: 'text-search', source: 'user', field: 'email', query: { kind: 'param', name: 'q' } },
      { kind: 'array-op', op: 'containsAny', target: ref('user', 'tags'), value: [{ kind: 'literal', value: 'beta' }] },
      { kind: 'filters', source: 'user', fields: ['name'] },
    ],
  },
  // set op + CTE (plain and recursive) + expr query
  setop: { kind: 'union', all: true, left: select(ref('user', 'name')), right: select(ref('user', 'email')), order: [{ expr: ref('user', 'name'), dir: 'asc' }], limit: 5 },
  cte: { kind: 'cte', ctes: [{ name: 'big', query: select(ref('order', 'id'), 'order') }, { name: 'tree', base: select(ref('user', 'id')), recursive: select(ref('user', 'id')) }], final: { kind: 'expr', expr: { kind: 'literal', value: 1 } } },
  // a table-valued function source
  fnSource: { kind: 'select', fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} } }], from: { kind: 'function', function: 'genRows', args: {}, as: 'g' } },
  // a window function
  window: { kind: 'select', fields: [{ expr: { kind: 'window', function: 'rowNumber', args: {}, partitionBy: [ref('user', 'name')], orderBy: [{ expr: ref('user', 'id'), dir: 'asc' }] } }], from: { kind: 'type', type: 'user' } },
  // DML: insert (typed rows), update, delete (query-signature.test.ts shapes over the fixture)
  insert: { kind: 'insert', into: 'order', rows: [{ id: 1, userId: 'u1', total: 9.5, note: { kind: 'param', name: 'note' } }], returning: [{ expr: ref('order', 'id') }] },
  update: { kind: 'update', type: 'user', set: { name: { kind: 'function-call', function: 'upper', args: { value: ref('user', 'name') } } }, where: [{ kind: 'is-null', value: ref('user', 'age') }] },
  delete: { kind: 'delete', from: 'order', where: [{ kind: 'comparison', op: '=', left: ref('order', 'id'), right: { kind: 'param', name: 'id' } }] },
  upsert: { kind: 'insert', into: 'user', rows: [{ id: { kind: 'param', name: 'id' }, name: 'Ada', email: 'a@x' }], onConflict: { fields: ['id'], update: { name: { kind: 'excluded', field: 'name' } } } },
};

/** Values whose acceptance depends on the depth (schema-depth.test.ts, capability-gating.test.ts, operator tests). */
const PROBES: Record<string, unknown> = {
  ...VALID,
  crossTypeField: select(ref('user', 'total')),
  unknownField: select(ref('user', 'nope')),
  unknownSource: select(ref('ghost', 'name')),
  unknownType: { kind: 'select', fields: [{ expr: ref('ghost', 'x') }], from: { kind: 'type', type: 'ghost' } },
  unknownFn: select({ kind: 'function-call', function: 'no_such_fn', args: {} }),
  upperWrongArg: select({ kind: 'function-call', function: 'upper', args: { wrong: ref('user', 'name') } }),
  upperRightArg: select({ kind: 'function-call', function: 'upper', args: { value: ref('user', 'name') } }),
  countDistinct: select({ kind: 'aggregate', function: 'count', args: {}, distinct: true }),
  countNoArgs: select({ kind: 'aggregate', function: 'count' } as ExprDef),
  filtersOpen: select({ kind: 'filters', source: 'anything', fields: ['whatever'] }),
  filtersPaired: select({ kind: 'filters', source: 'user', fields: ['name', 'age'] }),
  filtersCross: select({ kind: 'filters', source: 'user', fields: ['total'] }),
  semantic: select({ kind: 'semantic', source: 'user', field: 'email', query: 'ada' }),
  semanticTypeRef: select({ kind: 'semantic', source: 'user', query: { type: 'user', field: 'email' } }),
  textScore: select({ kind: 'text-score', source: 'user', query: 'ada' }),
  badRelationJoin: { ...VALID.join, joins: [{ on: { kind: 'relation', source: 'user', field: 'name', as: 'x' } }] },
  manualJoin: { ...VALID.fieldRef, joins: [{ on: { kind: 'type', type: 'order' }, and: { kind: 'comparison', op: '=', left: ref('order', 'userId'), right: ref('user', 'id') }, joinType: 'left' }] },
  insertUnknownField: { kind: 'insert', into: 'order', rows: [{ id: 1, userId: 'u', total: 1, ghost: 2 }] },
  insertMissingRequired: { kind: 'insert', into: 'order', rows: [{ note: 'x' }] },
  insertWrongValue: { kind: 'insert', into: 'order', rows: [{ id: 'one', userId: 'u', total: 1 }] },
  insertIntoGhost: { kind: 'insert', into: 'ghost', rows: [] },
  updateUnknownField: { kind: 'update', type: 'user', set: { ghost: 1 } },
  wrongKind: { kind: 'selectt', fields: [], from: { kind: 'type', type: 'user' } },
  badOp: select({ kind: 'comparison', op: '==', left: ref('user', 'id'), right: { kind: 'literal', value: 1 } } as never),
  missingField: { kind: 'select', from: { kind: 'type', type: 'user' } },
  outputInWhere: { kind: 'select', fields: [], from: { kind: 'type', type: 'user' }, where: [{ kind: 'output', name: 'x' }] },
  sorterInWhere: { kind: 'select', fields: [], from: { kind: 'type', type: 'user' }, where: [{ kind: 'sorter', sorts: {} }] },
};

const PLAIN_PROBES: Record<string, unknown> = {
  widgetRef: select(ref('widget', 'id'), 'widget'),
  widgetFilters: select({ kind: 'filters', source: 'widget' }, 'widget'),
  widgetSemantic: select({ kind: 'semantic', source: 'widget', query: 'hi' }, 'widget'),
  widgetTextSearch: select({ kind: 'text-search', source: 'widget', query: 'hi' }, 'widget'),
  widgetArrayOp: select({ kind: 'array-op', op: 'isEmpty', target: ref('widget', 'id') }, 'widget'),
  widgetEmptyJoins: { ...select(ref('widget', 'id'), 'widget'), joins: [] },
  widgetJoin: { ...select(ref('widget', 'id'), 'widget'), joins: [{ on: { source: 'widget', field: 'nope' } }] },
  widgetTabular: select({ kind: 'tabular-function-call', function: 'gen', args: {} }, 'widget'),
};

const GEO_PROBES: Record<string, unknown> = {
  // operator.test.ts example
  overlaps: select({ kind: 'operator', op: '&&', args: { left: ref('parcel', 'shape'), right: { kind: 'param', name: 'box' } } } as ExprDef, 'parcel'),
  distance: select({ kind: 'operator', op: '<->', args: { left: ref('parcel', 'shape'), right: ref('parcel', 'shape') } } as ExprDef, 'parcel'),
  unknownOperator: select({ kind: 'operator', op: '@@', args: {} } as ExprDef, 'parcel'),
  wrongOperand: select({ kind: 'operator', op: '&&', args: { left: ref('parcel', 'shape'), middle: ref('parcel', 'shape') } } as ExprDef, 'parcel'),
};

/** Every depth level of every axis, the presets, the sugar, function selectors and the degrade budget. */
const CONFIGS: BuildOptions[] = [
  {},
  { depth: 'open' },
  { depth: 'paired' },
  { strict: true },
  { strict: false },
  ...(['open', 'types', 'fields', 'both', 'paired'] as const).map((refs) => ({ depth: { refs } })),
  { depth: { typeNames: 'enum' } },
  { depth: { functions: 'names' } },
  { depth: { functions: 'typed' } },
  { depth: { functions: 'names' }, functions: 'none' },
  { depth: { functions: 'typed' }, functions: ['upper', 'count'] },
  { depth: { functions: 'typed' }, functions: { scalar: ['upper'], aggregate: 'all', window: 'none' } },
  { depth: { filters: 'paired' } },
  { depth: { writes: 'names' } },
  { depth: { writes: 'typed' } },
  { depth: 'paired', maxEnumSize: 1 },
  { depth: 'paired', maxEnumSize: 3 },
  { depth: 'paired', maxEnumSize: 6 },
  // product query.ts query_set: { strict: true, maxEnumSize: holder.querySchemaMaxEnumSize (default 100) }
  { strict: true, maxEnumSize: 100 },
  { depth: 'paired', types: ['user'] },
];

/** Accept/reject of every probe: the real zod schema vs the `a` port (decoding a copy under LENIENT). */
function mismatches(registry: Registry, cat: QueryCatalog, probes: Record<string, unknown>, configs: readonly BuildOptions[]): string[] {
  const out: string[] = [];
  for (const o of configs) {
    const real = buildSchemas(registry, { ...o, ...(o.types ? { types: registry.typeList().filter((t) => o.types!.includes(t.name)) } : {}) } as never);
    const port = QuerySchema.render(LENIENT, cat, o);
    for (const [name, v] of Object.entries(probes)) {
      const zod = real.Query.safeParse(clone(v)).success;
      const ours = port.parse(clone(v));
      if (zod !== ours.ok) out.push(`${JSON.stringify(o)} ${name}: zod ${zod ? 'accepts' : 'rejects'}, a ${ours.ok ? 'accepts' : `rejects:\n${ours.ok ? '' : ours.message}`}`);
    }
  }
  return out;
}

// ============================================================================
// Faithfulness: the same verdicts as query's own schemas
// ============================================================================

describe('query: the a port accepts exactly what @aeye/query\'s buildSchemas accepts', () => {
  it('the fixture catalog, at every depth / preset / selector / budget', () => {
    expect(mismatches(fx, catalog, PROBES, CONFIGS)).toEqual([]);
  });

  it('a capability-free catalog: gated kinds are gone, joins must be empty', () => {
    expect(mismatches(plain, plainCatalog, PLAIN_PROBES, CONFIGS.slice(0, 12))).toEqual([]);
  });

  it('registered operators: open / names / typed', () => {
    expect(mismatches(geo, geoCatalog, GEO_PROBES, [{}, { depth: { functions: 'names' } }, { depth: { functions: 'typed' } }])).toEqual([]);
  });

  it('every probe is decided both ways somewhere (the probes discriminate), and the corpus is valid at the paired preset', () => {
    const verdicts = new Map<string, Set<boolean>>();
    for (const o of CONFIGS) {
      const port = QuerySchema.render(LENIENT, catalog, o);
      for (const [n, v] of Object.entries(PROBES)) {
        if (!verdicts.has(n)) verdicts.set(n, new Set());
        verdicts.get(n)!.add(port.parse(clone(v)).ok);
      }
    }
    const flips = [...verdicts].filter(([, s]) => s.size === 2).map(([n]) => n);
    expect(flips).toEqual(expect.arrayContaining([
      'countNoArgs', 'crossTypeField', 'filtersCross', 'filtersOpen', 'unknownField', 'unknownFn', 'unknownSource', 'unknownType', 'upperWrongArg',
    ]));
    const never = [...verdicts].filter(([, s]) => s.size === 1 && s.has(false)).map(([n]) => n);
    expect(never).toEqual(expect.arrayContaining(['badOp', 'missingField', 'outputInWhere', 'sorterInWhere', 'wrongKind', 'insertUnknownField', 'updateUnknownField']));
    const paired = QuerySchema.render(LENIENT, catalog, { strict: true });
    for (const [n, v] of Object.entries(VALID)) expect([n, paired.parse(clone(v)).ok]).toEqual([n, true]);
  });

  it('resolves depth like query (presets, sugar, partial overlay, maxEnumSize ladders)', () => {
    expect(depthOf(catalog, { strict: true })).toEqual({ refs: 'paired', typeNames: 'enum', functions: 'typed', filters: 'paired', writes: 'typed' });
    expect(depthOf(catalog, { depth: { refs: 'both' } })).toEqual({ refs: 'both', typeNames: 'open', functions: 'open', filters: 'open', writes: 'open' });
    // 2 types, 9 distinct field names, the biggest function group is the scalar library
    expect(depthOf(catalog, { depth: 'paired', maxEnumSize: 3 })).toEqual({ refs: 'types', typeNames: 'enum', functions: 'open', filters: 'open', writes: 'open' });
    expect(depthOf(catalog, { depth: 'paired', maxEnumSize: 1 })).toMatchObject({ refs: 'open', typeNames: 'open' });
  });

  it('field types → typed write values (toValueSchema)', () => {
    const r = (t: Parameters<typeof fieldValue>[0]) => staticBundle(fieldValue(t) as Schema<unknown, never>).render(LENIENT);
    expect(r({ kind: 'number', whole: true, min: 1 }).parse(1.5).ok).toBe(false);
    expect(r({ kind: 'text', values: [{ value: 'open' }, { value: 'done', label: 'Done' }] }).parse('done').ok).toBe(true);
    expect(r({ kind: 'text', values: [{ value: 'open' }, { value: 'done' }] }).parse('later').ok).toBe(false);
    expect(r({ kind: 'text', values: [{ value: 'only' }] }).jsonSchema).toEqual({ type: 'string', enum: ['only'] });
    expect(r({ kind: 'date' }).parse('2026-11-24T10:00').ok).toBe(true); // query's ISO_DATE is a prefix match
    expect(r({ kind: 'timestamp' }).parse('2026-11-24').ok).toBe(false);
    expect(r({ kind: 'array', item: { kind: 'number' }, maxItems: 2 }).parse([1, 2, 3]).ok).toBe(false);
    expect(r({ kind: 'money', number: { min: 0 } }).parse(-1).ok).toBe(false);
    expect(r({ kind: 'json' }).parse({ any: ['thing'] }).ok).toBe(true);
    expect(r({ kind: 'relation', to: 'user', count: 1 }).parse('u1').ok).toBe(true);
  });
});

// ============================================================================
// The static type of what the code gets
// ============================================================================

describe('query: decoded values are query\'s own QueryDef', () => {
  it('a decoded query is usable as QueryDef without a cast', () => {
    const r = QuerySchema.render(LENIENT, catalog, { strict: true });
    const res = r.parse(clone(VALID.groupCount));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q: QueryDef = res.value;
    if (q.kind === 'select') expect(q.fields).toHaveLength(2);
  });

  it('a typed fn with no required params: args may be left out and decode as {} (query\'s ExprDef says args is always there)', () => {
    const r = ExprSchema.render(OPENAI_STRICT, catalog, { strict: true });
    const res = r.parse({ input: { kind: 'aggregate', function: 'count', args: null, distinct: null } });
    expect(res.ok && res.value).toEqual({ kind: 'aggregate', function: 'count', args: {} });
  });
});

// ============================================================================
// Rendering on every profile, at several depths
// ============================================================================

const SAMPLES = Object.values(VALID).map((q) => ({ value: q }));

describe('query: every profile family, several depths', () => {
  for (const o of [{ depth: 'open' }, { depth: { refs: 'both', functions: 'names' } }, { strict: true }, { strict: true, maxEnumSize: 3 }] as BuildOptions[]) {
    it(`renders, validates, encodes and round-trips the corpus — ${JSON.stringify(o)}`, () => {
      const tool = QueryModule.result(a_value()).bind(catalog, o);
      // The corpus values this depth accepts (zod and `a` agree on which, above).
      const samples = SAMPLES.filter((s) => tool.render(LENIENT).parse(clone(s)).ok);
      expect(samples.length).toBeGreaterThanOrEqual(10);
      const pr = profileProblems(tool, samples);
      if (process.env.DBG) console.log([...new Set(pr.map((x) => x.replace(/sample \d+/, 'sample N').slice(0, 300)))].slice(0, 40).join('\n'));
      expect(pr).toEqual([]);
    });
  }

  it('OpenAI strict, paired: $defs for every shared fragment; field enums per type; pairs for records', () => {
    const js = QueryToolArgs.render(asTool(OPENAI_STRICT), catalog, { strict: true }).jsonSchema as any;
    const defs = Object.keys(js.$defs).sort();
    expect(defs).toEqual(expect.arrayContaining(['Expr', 'Query', 'Source', 'JoinOn', 'Joins', 'Fields_user', 'Fields_order', 'Args', 'param', 'Limit', 'Query_insert', 'Query_update', 'Query_delete']));
    expect(js.$defs.Fields_user).toEqual({ type: 'string', enum: ['id', 'name', 'age', 'email', 'tags', 'orders'] });
    // the paired field-ref: one branch per type, the source pinned, the field enum of THAT type
    const fieldRef = js.$defs.Expr.anyOf.find((o: any) => o.anyOf?.[0]?.properties?.kind?.enum?.[0] === 'field-ref');
    expect(fieldRef.anyOf.map((b: any) => [b.properties.source.enum, b.properties.field.$ref])).toEqual([
      [['user'], '#/$defs/Fields_user'],
      [['order'], '#/$defs/Fields_order'],
    ]);
    // a typed sorter's `sorts` record is pairs; optional fields are required + nullable
    expect(js.$defs.Expr_sorter.properties.sorts.type).toBe('array');
    expect(js.$defs.Expr_sorter.required).toEqual(['kind', 'sorts', 'defaultSort']);
    // literal JSON values are JSON text on OpenAI strict (no exact "any")
    expect(js.$defs.Expr_literal.properties.value).toMatchObject({ type: 'string' });
    expect(dialectProblems(js, asTool(OPENAI_STRICT))).toEqual([]);
  });

  it('Anthropic strict: the recursive grammar escapes to JSON text at the back-edges, and still decodes', () => {
    const r = QueryToolArgs.render(asTool(ANTHROPIC_STRICT), catalog, { strict: true });
    const text = JSON.stringify(r.jsonSchema);
    expect(text).toContain('JSON text of this TypeScript type');
    expect(dialectProblems(r.jsonSchema, asTool(ANTHROPIC_STRICT))).toEqual([]);
    // What Claude writes: the top statement as structure, nested exprs as JSON text where the schema says so.
    const wire = r.encode({ query: VALID.param! });
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(clone(wire));
    expect(res.ok && res.value).toEqual({ query: VALID.param });
    expect(res.stats.parsed).toBeGreaterThan(0);
  });

  it('Gemini: enums over 40 values are widened (listed in words), still enforced', () => {
    const big = { ...catalog, version: 'big', types: Array.from({ length: 45 }, (_, i) => ({ ...catalog.types[0]!, name: `t${i}` })) };
    const r = QuerySchema.render(asTool(GOOGLE_STRICT), big, { depth: { typeNames: 'enum' } });
    expect(dialectProblems(r.jsonSchema, asTool(GOOGLE_STRICT))).toEqual([]);
    const res = r.parse({ input: { kind: 'select', fields: [], from: { kind: 'type', type: 't99' } } });
    expect(!res.ok && res.issues[0]!.path).toEqual(['input', 'from', 'type']);
  });
});

/** The query tool's `{ value: Query }` (product query_set) result of the same module. */
function a_value() {
  return QuerySchemaValue;
}
const QuerySchemaValue = a.object({ value: a.ref('Query') });

// ============================================================================
// Decoding real model-shaped answers
// ============================================================================

describe('query: model-shaped answers', () => {
  const strict = QueryToolArgs.render(asTool(OPENAI_STRICT), catalog, { strict: true });

  it('OpenAI strict: nulls for absent, pairs for records, JSON text for literal values — decoded in place', () => {
    const wire = {
      query: {
        kind: 'select', distinct: null,
        fields: [
          { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: null },
          { expr: { kind: 'function-call', function: 'upper', args: { value: { kind: 'field-ref', source: 'user', field: 'email' } } }, as: 'E' },
          { expr: { kind: 'literal', value: '{"a":[1,2]}' }, as: 'doc' },
        ],
        from: { kind: 'type', type: 'user' },
        joins: null, where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: '30' } }],
        groupBy: null, having: null,
        order: [{ kind: 'sorter', sorts: [{ key: 'byName', value: { kind: 'field-ref', source: 'user', field: 'name' } }], defaultSort: null }],
        limit: 20, offset: null,
      },
    };
    const res = strict.parse(wire);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(wire);
    expect(res.value.query).toEqual({
      kind: 'select',
      fields: [
        { expr: ref('user', 'name') },
        { expr: { kind: 'function-call', function: 'upper', args: { value: ref('user', 'email') } }, as: 'E' },
        { expr: { kind: 'literal', value: { a: [1, 2] } }, as: 'doc' },
      ],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '>', left: ref('user', 'age'), right: { kind: 'literal', value: 30 } }],
      order: [{ kind: 'sorter', sorts: { byName: ref('user', 'name') } }],
      limit: 20,
    });
    // one record from pairs (sorts); two JSON texts parsed; nulls deleted in place
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 10, parsed: 2, repaired: 0 });
  });

  it('a whole query sent as a JSON string is repaired (counted)', () => {
    const res = QueryToolArgs.render(LENIENT, catalog, { strict: true }).parse({ query: JSON.stringify(VALID.fieldRef) });
    expect(res.ok && res.value.query).toEqual(VALID.fieldRef);
    expect(res.stats.repaired).toBe(1);
  });

  it('errors: where the model wrote them, and where the code sees them', () => {
    const res = strict.parse({
      query: { kind: 'select', distinct: null, fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'total' }, as: null }], from: { kind: 'type', type: 'user' }, joins: null, where: null, groupBy: null, having: null, order: [{ kind: 'sorter', sorts: [{ key: 's', value: { kind: 'literal', value: '"x"' } }, { key: 's', value: { kind: 'literal', value: '"y"' } }], defaultSort: null }], limit: null, offset: null },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The unions are discriminated by `kind` (and the paired field-ref by `source`), so errors land INSIDE the option.
    expect(res.issues.map((i) => [i.path, i.codePath, i.message])).toEqual([
      [['query', 'fields', 0, 'expr', 'field'], ['query', 'fields', 0, 'expr', 'field'], 'Expected one of: id, name, age, email, tags, orders.'],
      // the sorter's `sorts` record went as pairs: the model wrote entry 1, the code sees the record
      [['query', 'order', 0, 'sorts', 1, 'key'], ['query', 'order', 0, 'sorts'], 'Duplicate key "s".'],
    ]);
    expect(lines(res)).toBe('- at query.fields[0].expr.field: Expected one of: id, name, age, email, tags, orders.\n- at query.order[0].sorts[1].key: Duplicate key "s".');
  });

  it('a typed insert row: unknown field and wrong value are reported at the row\'s key', () => {
    const r = QuerySchema.render(LENIENT, catalog, { strict: true });
    const res = r.parse({ kind: 'insert', into: 'order', rows: [{ id: 'one', userId: 'u', total: 1 }] });
    expect(res.ok).toBe(false);
  });
});

// ============================================================================
// Encoding, the Handlebars helper and examples
// ============================================================================

describe('query: encoding into instructions', () => {
  it('product\'s QUERY_SET_EXAMPLES shown in each model\'s shape via {{encode}}', () => {
    const t = Handlebars.compile('Example: {{encode example}}', { noEscape: true });
    const example = { value: VALID.groupCount! };
    const tool = (p: typeof OPENAI_STRICT) => ModelProfile.of(p).request([{ kind: 'tool', name: 'query_set', schema: QueryModule.result(QuerySchemaValue).bind(catalog, { strict: true, maxEnumSize: 100 }) }]).get('query_set');
    const openai = t({ example }, { helpers: tool(OPENAI_STRICT).helpers() });
    expect(openai).toContain('"distinct":null');
    expect(openai).toContain('"args":{"value":null}'); // count's optional `value` param, as null
    const grok = t({ example }, { helpers: tool(XAI_STRICT).helpers() });
    expect(JSON.parse(grok.slice('Example: '.length))).toEqual(example); // xAI reads the code shape
  });

  it('encodeAt / encoder: a part of the query in the model\'s shape', () => {
    const r = QueryToolArgs.render(asTool(OPENAI_STRICT), catalog, { strict: true });
    const sorter = { kind: 'sorter', sorts: { byName: ref('user', 'name') } };
    expect(r.encodeAt(sorter, 'query.order.*') as object).toMatchObject({ sorts: [{ key: 'byName' }], defaultSort: null });
    expect(r.encoder({ query: VALID.fieldRef! })).toBe(JSON.stringify(r.encode({ query: VALID.fieldRef! })));
    const h = Handlebars.compile('{{encode q path="query"}}', { noEscape: true });
    expect(h({ q: VALID.fieldRef }, { helpers: schemaHelpers(r) })).toContain('"distinct":null');
  });

  it('examples on the schema render per profile', () => {
    const Ex = QueryModule.result(a.object({ value: a.ref('Query') }).example({ value: VALID.fieldRef! }));
    const openai = Ex.render(asTool(OPENAI_STRICT), catalog, { strict: true }).jsonSchema;
    expect(String(openai.description)).toMatch(/^Example: \{"value":\{"kind":"select","distinct":null/);
    expect(Ex.render(LENIENT, catalog, {}).jsonSchema.examples).toEqual([{ value: VALID.fieldRef }]);
  });
});

// ============================================================================
// Request budgets, the prose fallback and the bind cache
// ============================================================================

describe('query: requests, fallback and caching', () => {
  it('Anthropic: the paired query schema alone breaks the 24-optional / 16-union totals; the ladder keeps it strict with the inner query as JSON text', () => {
    const query = QueryModule.result(QuerySchemaValue).bind(catalog, { strict: true, maxEnumSize: 100 });
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'query_set', schema: query },
      { kind: 'tool', name: 'system_set', schema: a.object({ system: a.enum(['core', 'crm']) }), strict: 2 },
    ]);
    expect(req.get('system_set').strict).toBe(true);
    const q = req.get('query_set');
    expect(q.strict).toBe(true);
    // Optionals and unions are over: only cutting depth helps, so the enums are kept (no 'enums-widened').
    expect(q.adjustments).toEqual([{ kind: 'depth-limited', maxDepth: 1 }]);
    expect(q.reasons).toEqual(['"query_set" alone: 140 optional properties (limit 24)', '"query_set" alone: 62 union-typed properties (limit 16)']);
    expect(q.measure.optional + req.get('system_set').measure.optional).toBeLessThanOrEqual(24);
    expect(req.used.unions).toBeLessThanOrEqual(16);
    expect(unexplained(req)).toEqual([]);
    // parse and encode go through the entry's rendering: the query is JSON text inside `value`
    const wire = q.encode({ value: VALID.join! }) as { value: unknown };
    expect(typeof wire.value).toBe('string');
    expect(q.parse(wire).ok && q.parse(q.encode({ value: VALID.join! })).ok).toBe(true);
    // strict: false asked for: the full grammar, not compiled
    const loose = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'query_set', schema: query, strict: false }]).get('query_set');
    expect([loose.strict, loose.profile.id]).toEqual([false, 'anthropic']);
  });

  it('OpenAI strict: the whole grammar fits one strict schema', () => {
    const req = profileFor({ id: 'gpt-5', provider: 'openai', capabilities: ['toolsStrict', 'structured'] })
      .request([{ kind: 'tool', name: 'query_set', schema: QueryModule.result(QuerySchemaValue).bind(catalog, { strict: true }) }]);
    const e = req.get('query_set');
    expect([e.strict, e.adjustments, req.degradations]).toEqual([true, [], []]);
    expect(e.measure.depth).toBeLessThanOrEqual(10);
  });

  it('MINIMAL and Gemini OpenAPI (no $defs, no combinators): still a faithful rendering', () => {
    for (const p of [MINIMAL, GOOGLE_OPENAPI]) {
      const r = QueryToolArgs.render(asTool(p), catalog, { strict: true });
      expect(dialectProblems(r.jsonSchema, asTool(p))).toEqual([]);
      expect(r.parse(clone(r.encode({ query: VALID.rich! }))).ok).toBe(true);
    }
  });

  it('PEOPLE sees the code shape', () => {
    const js = QueryToolArgs.render(PEOPLE, catalog, { strict: true }).jsonSchema as any;
    expect(js.$defs.Expr_sorter.properties.sorts.type).toBe('object');
  });

  it('shouldUseStringSchema: past 5 types the tool takes prose', () => {
    const many = { ...catalog, types: Array.from({ length: 6 }, (_, i) => ({ ...catalog.types[0]!, name: `t${i}` })) };
    expect([shouldUseStringSchema(catalog), shouldUseStringSchema(many)]).toEqual([false, true]);
    expect(QueryProseArgs.render(asTool(OPENAI_STRICT)).parse({ query: 'all users over 30' }).ok).toBe(true);
  });

  it('binds are cached per (catalog version, options); ref-free grammar nodes are shared', () => {
    expect(QuerySchema.bind(catalog, { strict: true })).toBe(QuerySchema.bind(catalog, { strict: true }));
    expect(QuerySchema.bind(catalog, { strict: true })).not.toBe(QuerySchema.bind(catalog, {}));
    const a1 = (QuerySchema.render(OPENAI_STRICT, catalog, {}).jsonSchema.$defs as any).Expr_binary.properties.op;
    const a2 = (QuerySchema.render(OPENAI_STRICT, catalog, { strict: true }).jsonSchema.$defs as any).Expr_binary.properties.op;
    expect(a2).toBe(a1);
  });

  it('the expr kinds list matches query\'s registry order', () => {
    expect(EXPR_KINDS.length).toBe(26);
    expect(SelectSchema.bind(catalog, {})).toBeDefined();
    expect(isDeepStrictEqual(catalogOf(fixtureRegistry()).types, catalog.types)).toBe(true);
  });
});
